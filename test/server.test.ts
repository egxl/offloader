import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { callCodexCompletion, type CodexClientFactory } from "../src/codex.js";
import {
  callChatCompletion,
  getFallbackChain,
  getProviderConfigs,
  resolveProviderId,
} from "../src/providers.js";
import { resolveWithinWorkspace } from "../src/files.js";

test("provider configs use updated OpenCode Console, Go, and DeepSeek endpoints", () => {
  const configs = getProviderConfigs({});
  assert.equal(
    configs.opencode.chatUrl,
    "https://opencode.ai/inference/openai/v1/chat/completions"
  );
  assert.equal(
    configs["opencode-go"].chatUrl,
    "https://opencode.ai/inference/go/openai/v1/chat/completions"
  );
  assert.equal(
    configs.deepseek.chatUrl,
    "https://api.deepseek.com/v1/chat/completions"
  );
});

test("resolveProviderId prioritizes explicit provider and env keys", () => {
  assert.equal(resolveProviderId("deepseek", { OPENCODE_API_KEY: "x" }), "deepseek");
  assert.equal(resolveProviderId(undefined, { DEEPSEEK_API_KEY: "ds" }), "deepseek");
  assert.equal(resolveProviderId(undefined, { OPENCODE_API_KEY: "oc" }), "opencode");
  assert.equal(
    resolveProviderId(undefined, {
      OPENCODE_API_KEY: "oc",
      OPENCODE_USE_GO: "true",
    }),
    "opencode-go"
  );
});

test("getFallbackChain uses default order and filters custom entries", () => {
  const env = {
    CODEX_API_KEY: "codex-test",
    OPENCODE_API_KEY: "opencode-test",
    DEEPSEEK_API_KEY: "deepseek-test",
  };
  assert.deepEqual(getFallbackChain("deepseek", env), [
    "deepseek", "codex", "opencode-go", "opencode",
  ]);
  assert.deepEqual(
    getFallbackChain("codex", {
      DEEPSEEK_API_KEY: "deepseek-test",
      OFFLOAD_FALLBACK_ORDER: " deepseek, unknown, deepseek, codex, opencode, constructor ",
    }),
    ["codex", "deepseek"]
  );
  assert.deepEqual(getFallbackChain("codex", env, false), ["codex"]);
});

test("Windows Codex workspace-write sets default and overridden sandbox config", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const capturedOptions: Parameters<CodexClientFactory>[0][] = [];
  const makeThread = (id: string) => ({
    id,
    async run() {
      return { finalResponse: "Done", items: [], usage: null };
    },
  });
  const codexFactory: CodexClientFactory = (options) => {
    capturedOptions.push(options);
    return {
      startThread: () => makeThread("thread"),
      resumeThread: makeThread,
    };
  };

  const params = { prompt: "Review", workingDirectory: process.cwd() };
  await callCodexCompletion({ ...params, sandboxMode: "workspace-write" }, {}, codexFactory);
  await callCodexCompletion(
    { ...params, sandboxMode: "workspace-write" },
    { CODEX_WINDOWS_SANDBOX: " elevated " },
    codexFactory
  );
  await callCodexCompletion(params, {}, codexFactory);

  assert.deepEqual(capturedOptions, [
    { config: { features: { prefer_mxc: true }, windows: { sandbox: "unelevated" } } },
    { config: { features: { prefer_mxc: true }, windows: { sandbox: "elevated" } } },
    {},
  ]);
});

for (const allowFallback of [undefined, false]) {
  test(`offload_task handles Codex quota errors with allow_fallback=${allowFallback}`, async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "offload-fallback-"));
    const client = new Client({ name: "fallback-test", version: "1.0.0" });
    let codexPrompt = "";
    const quotaThread = () => ({
      id: "codex-thread",
      async run(input: string | unknown[]) {
        codexPrompt = String(input);
        throw new Error("quota exceeded");
      },
    });
    const requests: Array<{ url: string; body: string }> = [];
    const server = createServer({
      env: { DEEPSEEK_API_KEY: "deepseek-test", OFFLOAD_FALLBACK_ORDER: "deepseek" },
      codexFactory: () => ({ startThread: quotaThread, resumeThread: quotaThread }),
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return Response.json({ choices: [{ message: { content: "DeepSeek result" } }] });
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await fs.writeFile(path.join(workspace, "input.ts"), "export const fromDisk = 42;");
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({
        name: "offload_task",
        arguments: {
          provider: "codex",
          model: "codex-test-model",
          prompt: "Review this code",
          workspace_dir: workspace,
          file_paths: ["input.ts"],
          allow_fallback: allowFallback,
        },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      assert.match(codexPrompt, /Focus workspace files.*input\.ts/);
      assert.doesNotMatch(codexPrompt, /fromDisk/);

      if (allowFallback === false) {
        assert.equal(result.isError, true);
        assert.match(text, /codex: Codex execution failed: quota exceeded/);
        assert.equal(requests.length, 0);
      } else {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "https://api.deepseek.com/v1/chat/completions");
        const body = JSON.parse(requests[0].body);
        assert.equal(body.model, "deepseek-chat");
        assert.match(body.messages[1].content, /export const fromDisk = 42;/);
        assert.match(text, /provider=deepseek.*files=1.*fallback_from=codex \(Codex execution failed: quota exceeded\)/);
        assert.match(text, /DeepSeek result/);
      }
    } finally {
      await client.close();
      await server.close();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}

test("resolveWithinWorkspace blocks path traversal", () => {
  const root = path.resolve("C:\\tmp\\ws-test");
  assert.throws(() => resolveWithinWorkspace(root, "../secret.txt"));
  const ok = resolveWithinWorkspace(root, "src/app.ts");
  assert.equal(ok.relPath, path.join("src", "app.ts"));
});

test("callChatCompletion sends OpenCode headers and surfaces 403 free-tier hint", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  };

  await assert.rejects(
    () =>
      callChatCompletion(
        {
          provider: "opencode-go",
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
          sessionId: "ses_test_123",
        },
        { OPENCODE_API_KEY: "oc_sk_test" },
        mockFetch
      ),
    /free-tier models.*403/i
  );

  assert.equal(
    capturedUrl,
    "https://opencode.ai/inference/go/openai/v1/chat/completions"
  );
  assert.equal(capturedHeaders.Authorization, "Bearer oc_sk_test");
  assert.equal(capturedHeaders["x-opencode-session"], "ses_test_123");
  assert.match(capturedHeaders["User-Agent"], /^antigravity-offload-mcp\//);
});

test("MCP tools list_offload_models and offload_task work end-to-end with files and output_file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "offload-mcp-"));
  try {
    await fs.writeFile(path.join(tmpDir, "input.ts"), "export const x = 1;\n", "utf8");

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "deepseek-chat", name: "DeepSeek Chat" },
              { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, "deepseek-reasoner");
      assert.match(body.messages[1].content, /export const x = 1;/);

      return new Response(
        JSON.stringify({
          model: "deepseek-reasoner",
          choices: [
            {
              finish_reason: "stop",
              message: {
                reasoning_content: "Checked x.",
                content: "export const x: number = 1;\n",
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const server = createServer({
      env: { DEEPSEEK_API_KEY: "ds_test_key" },
      fetchFn: mockFetch,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const modelsRes = await client.callTool({
      name: "list_offload_models",
      arguments: { provider: "deepseek", filter: "reasoner" },
    });
    const modelsText = (modelsRes.content as Array<{ text: string }>)[0].text;
    assert.match(modelsText, /\[1 matched\]:\n- deepseek-reasoner/);
    assert.doesNotMatch(modelsText, /- deepseek-chat \(/);

    const offloadRes = await client.callTool({
      name: "offload_task",
      arguments: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        prompt: "Add explicit type annotation",
        workspace_dir: tmpDir,
        file_paths: ["input.ts"],
        output_file: "out/typed.ts",
      },
    });
    const offloadText = (offloadRes.content as Array<{ text: string }>)[0].text;
    assert.match(offloadText, /provider=deepseek \| model=deepseek-reasoner/);
    assert.match(offloadText, /Wrote 28 chars to "out[\\/]typed\.ts"/);

    const written = await fs.readFile(path.join(tmpDir, "out", "typed.ts"), "utf8");
    assert.equal(written, "export const x: number = 1;\n");

    await client.close();
    await server.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("stdio transport spawns dist/index.js and registers both tools", async () => {
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/index.js")],
  });

  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["generate_image", "list_offload_models", "offload_task"]);
  await client.close();
});

test("MCP tools support provider='codex' with thread start/resume and reasoning", async () => {
  let startCalled = 0;
  let resumeCalledWith: string | undefined;
  let lastSandbox: string | undefined;
  let lastPrompt = "";

  const mockCodexFactory: CodexClientFactory = () => ({
    startThread(opts) {
      startCalled += 1;
      lastSandbox = opts?.sandboxMode;
      return {
        id: "thr_codex_123",
        async run(input) {
          lastPrompt = typeof input === "string" ? input : JSON.stringify(input);
          return {
            finalResponse: "Codex result output",
            items: [{ id: "r1", type: "reasoning", text: "Analyzed repo." }],
            usage: {
              input_tokens: 15,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 7,
              reasoning_output_tokens: 2,
            },
          };
        },
      };
    },
    resumeThread(id, opts) {
      resumeCalledWith = id;
      lastSandbox = opts?.sandboxMode;
      return {
        id,
        async run(input) {
          lastPrompt = typeof input === "string" ? input : JSON.stringify(input);
          return {
            finalResponse: "Resumed Codex output",
            items: [
              {
                id: "fc1",
                type: "file_change",
                status: "completed",
                changes: [{ kind: "update", path: "src/app.ts" }],
              },
              {
                id: "cmd1",
                type: "command_execution",
                command: "npm test",
                aggregated_output: "ok",
                exit_code: 0,
                status: "completed",
              },
            ],
            usage: null,
          };
        },
      };
    },
  });

  const server = createServer({
    env: {},
    codexFactory: mockCodexFactory,
  });
  const client = new Client({ name: "codex-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listRes = await client.callTool({
    name: "list_offload_models",
    arguments: { provider: "codex" },
  });
  const listText = (listRes.content as Array<{ text: string }>)[0].text;
  assert.match(listText, /codex \(OpenAI Codex CLI \/ ChatGPT Subscription\)/);
  assert.match(listText, /chatgpt-subscription-default/);

  const firstRes = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      prompt: "Review architecture",
      file_paths: ["src/index.ts"],
      system_prompt: "Be concise",
      include_reasoning: true,
    },
  });
  const firstText = (firstRes.content as Array<{ text: string }>)[0].text;
  assert.equal(startCalled, 1);
  assert.equal(lastSandbox, "read-only");
  assert.match(lastPrompt, /System instructions:\nBe concise/);
  assert.match(lastPrompt, /Focus workspace files.*src[\\/]index\.ts/);
  assert.match(firstText, /provider=codex \| model=chatgpt-subscription-default \| thread=thr_codex_123 \| focus_files=1/);
  assert.match(firstText, /<reasoning>\nAnalyzed repo\.\n<\/reasoning>/);
  assert.match(firstText, /Codex result output/);

  const secondRes = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      thread_id: "thr_codex_123",
      codex_sandbox: "workspace-write",
      prompt: "Apply fix",
    },
  });
  const secondText = (secondRes.content as Array<{ text: string }>)[0].text;
  assert.equal(resumeCalledWith, "thr_codex_123");
  assert.equal(lastSandbox, "workspace-write");
  assert.match(lastPrompt, /Edit files directly in the workspace/);
  assert.match(secondText, /Changed files: update:src\/app\.ts/);
  assert.match(secondText, /Commands run: npm test \(exit=0\)/);
  assert.match(secondText, /Resumed Codex output/);

  const invalidRes = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      codex_sandbox: "workspace-write",
      output_file: "summary.txt",
      prompt: "Should fail",
    },
  });
  assert.equal(invalidRes.isError, true);
  assert.match(
    (invalidRes.content as Array<{ text: string }>)[0].text,
    /Do not combine output_file with codex_sandbox/
  );

  await client.close();
  await server.close();
});

test("generate_image prefixes $imagegen, copies new PNG into workspace_dir, and supports input_images + thread_id", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "offload-img-"));
  const codexHome = path.join(tmpRoot, "codex-home");
  const workspaceDir = path.join(tmpRoot, "workspace");
  await fs.mkdir(path.join(codexHome, "generated_images", "thr_img_1"), {
    recursive: true,
  });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "ref.png"), "ref-bytes", "utf8");

  let capturedInput: unknown;
  const mockCodexFactory: CodexClientFactory = () => ({
    startThread() {
      return {
        id: "thr_img_1",
        async run(input) {
          capturedInput = input;
          await fs.writeFile(
            path.join(codexHome, "generated_images", "thr_img_1", "gen-1.png"),
            "new-png-1",
            "utf8"
          );
          return {
            finalResponse: "Generated icon",
            items: [],
            usage: null,
          };
        },
      };
    },
    resumeThread(id) {
      return {
        id,
        async run(input) {
          capturedInput = input;
          await fs.writeFile(
            path.join(codexHome, "generated_images", id, "gen-2.png"),
            "new-png-2",
            "utf8"
          );
          return {
            finalResponse: "Refined icon",
            items: [],
            usage: null,
          };
        },
      };
    },
  });

  try {
    const server = createServer({
      env: { CODEX_HOME: codexHome },
      codexFactory: mockCodexFactory,
    });
    const client = new Client({ name: "img-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const first = await client.callTool({
      name: "generate_image",
      arguments: {
        prompt: "Flat blue circle icon",
        workspace_dir: workspaceDir,
        output_file: "assets/icon.png",
        input_images: ["ref.png"],
      },
    });
    const firstText = (first.content as Array<{ text: string }>)[0].text;
    assert.ok(Array.isArray(capturedInput));
    assert.equal((capturedInput as Array<{ type: string; text?: string }>)[0].text, "$imagegen Flat blue circle icon");
    assert.equal(
      (capturedInput as Array<{ type: string; path?: string }>)[1].path,
      path.join(workspaceDir, "ref.png")
    );
    assert.match(firstText, /Saved to workspace: assets[\\/]icon\.png \(9 bytes\)/);
    assert.equal(
      await fs.readFile(path.join(workspaceDir, "assets", "icon.png"), "utf8"),
      "new-png-1"
    );

    const second = await client.callTool({
      name: "generate_image",
      arguments: {
        prompt: "$imagegen Make background dark",
        workspace_dir: workspaceDir,
        output_file: "assets/icon-v2.png",
        thread_id: "thr_img_1",
      },
    });
    const secondText = (second.content as Array<{ text: string }>)[0].text;
    assert.equal(capturedInput, "$imagegen Make background dark");
    assert.match(secondText, /Saved to workspace: assets[\\/]icon-v2\.png \(9 bytes\)/);
    assert.equal(
      await fs.readFile(path.join(workspaceDir, "assets", "icon-v2.png"), "utf8"),
      "new-png-2"
    );

    await client.close();
    await server.close();
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
