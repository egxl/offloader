import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ThreadOptions } from "@openai/codex-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, findMissingCodexSkills } from "../src/index.js";
import { callCodexCompletion, type CodexClientFactory } from "../src/codex.js";
import {
  clampReasoningEffort,
  inferCodexTaskTier,
  readCodexModelsCache,
  selectCodexModelAndEffort,
  type CodexSelectionInput,
} from "../src/codex-models.js";
import {
  callChatCompletion,
  getFallbackChain,
  getProviderConfigs,
  resolveProviderId,
} from "../src/providers.js";
import { resolveWithinWorkspace } from "../src/files.js";

const codexCacheFixture = [
  {
    slug: "gpt-6.2-sol",
    display_name: "GPT-6.2 Sol",
    visibility: "list",
    priority: 5,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" },
    ],
  },
  { slug: "gpt-unlisted", visibility: "list" },
  { slug: "gpt-hidden-sol", visibility: "hide", priority: 0 },
  { slug: "gpt-6-luna", visibility: "list", priority: 2 },
  { slug: "gpt-6.1-terra", visibility: "list", priority: 3 },
  { slug: "gpt-6.2-astra", visibility: "list", priority: 4 },
  { slug: "gpt-6.1-sol", visibility: "list", priority: 1, description: " Previous generation model" },
  { slug: "gpt-6-sol", visibility: "list", priority: 6, upgrade: { model: "gpt-6.2-sol" } },
  { slug: "gpt-unspecified" },
  null,
];

async function createTestCodexHome(t: TestContext, models?: readonly unknown[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offload-models-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  if (models) {
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models }));
  }
  return { CODEX_HOME: codexHome };
}

async function connectTestClient(t: TestContext, deps: Parameters<typeof createServer>[0]) {
  const server = createServer(deps);
  const client = new Client({ name: "codex-model-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("findMissingCodexSkills checks user and system skills and deduplicates mentions", async (t) => {
  const env = await createTestCodexHome(t);
  for (const name of ["ponytail", ".system/imagegen"]) {
    const dir = path.join(env.CODEX_HOME, "skills", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "");
  }

  assert.deepEqual(
    findMissingCodexSkills(
      "Use $ponytail, $missing-skill, $imagegen, $another, and $missing-skill. echo $HOME $env:PATH $1",
      env
    ),
    ["missing-skill", "another"]
  );
});

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
      assert.match(codexPrompt, /Attached workspace files[\s\S]*input\.ts/);
      assert.match(codexPrompt, /fromDisk/);

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

test("offload_task reports skill notices below the header in both output modes", async (t) => {
  const env = { ...await createTestCodexHome(t), DEEPSEEK_API_KEY: "ds_test_key" };
  const skillsDir = path.join(env.CODEX_HOME, "skills");
  await fs.mkdir(path.join(skillsDir, "ponytail"), { recursive: true });
  await fs.writeFile(path.join(skillsDir, "ponytail", "SKILL.md"), "");
  await fs.writeFile(path.join(env.CODEX_HOME, "input.txt"), "Use $attachment-skill.");

  const thread = {
    id: "thr_skills",
    async run() {
      return { finalResponse: "Done.", items: [], usage: null };
    },
  };
  const mockCodexFactory: CodexClientFactory = () => ({
    startThread: () => thread,
    resumeThread: () => thread,
  });
  const client = await connectTestClient(t, {
    env,
    codexFactory: mockCodexFactory,
    fetchFn: async () => Response.json({
      model: "deepseek-chat",
      choices: [{ finish_reason: "stop", message: { content: "Done." } }],
    }),
  });
  const args = {
    prompt: "Use the $ponytail and $nosuchskill skills. echo $HOME",
    workspace_dir: env.CODEX_HOME,
  };
  const warning = `Warning: Codex skill not found in ${skillsDir}: $nosuchskill`;

  const normal = await client.callTool({
    name: "offload_task",
    arguments: { ...args, provider: "codex", allow_fallback: false },
  });
  assert.notEqual(normal.isError, true, JSON.stringify(normal.content));
  const [codexHeader, ...codexBody] = (normal.content as Array<{ text: string }>)[0].text.split("\n");
  assert.match(codexHeader, /^\[provider=codex \|/);
  assert.deepEqual(codexBody, [warning, "", "Done."]);

  const output = await client.callTool({
    name: "offload_task",
    arguments: { ...args, provider: "deepseek", file_paths: ["input.txt"], output_file: "out.txt" },
  });
  assert.notEqual(output.isError, true, JSON.stringify(output.content));
  const [httpHeader, ...httpBody] = (output.content as Array<{ text: string }>)[0].text.split("\n");
  assert.match(httpHeader, /^\[provider=deepseek \|/);
  assert.deepEqual(httpBody, [
    warning,
    "Note: $skill mentions only load with provider=codex.",
    'Wrote 5 chars to "out.txt".',
    "",
    "Preview:",
    "Done.",
  ]);
  assert.equal(await fs.readFile(path.join(env.CODEX_HOME, "out.txt"), "utf8"), "Done.");
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

test("MCP tools support provider='codex' with thread start/resume and reasoning", async (t) => {
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
    env: await createTestCodexHome(t),
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
  assert.match(lastPrompt, /Attached workspace files[\s\S]*src[\\/]index\.ts/);
  assert.match(firstText, /provider=codex \| model=chatgpt-subscription-default \| thread=thr_codex_123 \| files=1 \(\d+ bytes\)/);
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

test("list_offload_models uses the visible Codex cache and filters by ID or name", async (t) => {
  const client = await connectTestClient(t, { env: await createTestCodexHome(t, codexCacheFixture) });

  const list = async (filter?: string) => {
    const result = await client.callTool({
      name: "list_offload_models",
      arguments: { provider: "codex", filter },
    });
    assert.notEqual(result.isError, true);
    return (result.content as Array<{ text: string }>)[0].text;
  };
  const text = await list();
  assert.match(text, /default=auto-pareto \(from models_cache\.json\)/);
  assert.deepEqual(Array.from(text.matchAll(/^- ((?:gpt-|chatgpt-)[\w.-]+)/gm), (match) => match[1]), [
    "chatgpt-subscription-default", "gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra",
    "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-sol", "gpt-unlisted",
  ]);
  assert.match(text, /gpt-6\.1-sol .*\[legacy\]/);
  assert.match(text, /gpt-6-sol .*\[legacy\]/);
  assert.match(text, /gpt-6-luna .*\[Pareto: quick\]/);
  assert.match(text, /gpt-6\.1-terra .*\[Pareto: vision\]/);
  assert.match(text, /gpt-6\.2-astra .*\[Pareto: frontier\]/);
  assert.match(text, /gpt-6\.2-sol \(GPT-6\.2 Sol \[Pareto: standard\/deep; default: medium; supported: low, medium, high, max\]\)/);

  const byName = await list("PARETO: VISION");
  assert.match(byName, /\[1 matched\]:\n- gpt-6\.1-terra /);
  const byId = await list("GPT-6.2-ASTRA");
  assert.match(byId, /\[1 matched\]:\n- gpt-6\.2-astra /);
});

test("list_offload_models advertises the SDK default and static models without a Codex cache", async (t) => {
  const client = await connectTestClient(t, { env: await createTestCodexHome(t) });
  const result = await client.callTool({
    name: "list_offload_models",
    arguments: { provider: "codex" },
  });
  assert.notEqual(result.isError, true);
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.match(text, /default=chatgpt-subscription-default/);
  assert.match(text, /\[3 matched\]:\n- chatgpt-subscription-default .*\n- gpt-6\.2-sol .*\n- gpt-6\.2-astra /);
});

test("Codex cache reader tolerates missing, malformed, and empty caches", async (t) => {
  const env = await createTestCodexHome(t);
  assert.equal(readCodexModelsCache(env), null);
  await fs.mkdir(env.CODEX_HOME);
  const cachePath = path.join(env.CODEX_HOME, "models_cache.json");
  for (const contents of ["{bad JSON", "null", '{"models":{}}']) {
    await fs.writeFile(cachePath, contents);
    assert.equal(readCodexModelsCache(env), null);
  }
  await fs.writeFile(cachePath, '{"models":[]}');
  assert.deepEqual(readCodexModelsCache(env), []);
  assert.deepEqual(selectCodexModelAndEffort({ prompt: "Review architecture" }, env), {
    model: undefined,
    reasoningEffort: undefined,
    source: "default",
    reason: "Codex models cache unavailable; using SDK default.",
  });
});

test("Codex infers task tiers by complexity, prompt length, and sandbox", () => {
  const cases: Array<[Parameters<typeof inferCodexTaskTier>[0], string]> = [
    [{ prompt: "Review the architecture" }, "frontier"],
    [{ prompt: "SECURITY AUDIT" }, "frontier"],
    [{ prompt: "Check this", fileCount: 6 }, "deep"],
    [{ prompt: "Apply migration", sandboxMode: "workspace-write" }, "standard"],
    [{ prompt: "Implement architecture", sandboxMode: "workspace-write" }, "standard"],
    [{ prompt: "Edit files", sandboxMode: "workspace-write", fileCount: 4 }, "standard"],
    [{ prompt: "Investigate a root-cause" }, "deep"],
    [{ prompt: "Format these", fileCount: 3 }, "deep"],
    [{ prompt: "Summarize", fileCount: 1, sandboxMode: "read-only" }, "quick"],
    [{ prompt: "Commit message" }, "quick"],
    [{ prompt: "Format this", fileCount: 2 }, "standard"],
    [{ prompt: "Fix typo", sandboxMode: "workspace-write" }, "standard"],
    [{ prompt: "Summary" + "x".repeat(321) + " format" }, "standard"],
    [{ prompt: "Add a feature" }, "standard"],
  ];
  for (const [input, tier] of cases) {
    assert.equal(inferCodexTaskTier(input), tier, JSON.stringify(input));
  }
});

test("Codex selects Pareto models and effort for all tiers and image input", async (t) => {
  const env = await createTestCodexHome(t, codexCacheFixture);
  const cases: Array<[Partial<CodexSelectionInput>, string, string]> = [
    [{ taskTier: "quick", sandboxMode: "read-only" }, "gpt-6-luna", "medium"],
    [{ taskTier: "quick", sandboxMode: "workspace-write" }, "gpt-6.2-sol", "low"],
    [{ taskTier: "quick", sandboxMode: "danger-full-access" }, "gpt-6.2-sol", "low"],
    [{ taskTier: "standard" }, "gpt-6.2-sol", "medium"],
    [{ taskTier: "deep" }, "gpt-6.2-sol", "high"],
    [{ taskTier: "frontier" }, "gpt-6.2-astra", "high"],
    [{ taskTier: "quick", hasInputImages: true }, "gpt-6.1-terra", "medium"],
    [{ taskTier: "frontier", hasInputImages: true }, "gpt-6.1-terra", "high"],
  ];
  for (const [input, model, reasoningEffort] of cases) {
    const selection = selectCodexModelAndEffort({ prompt: "Review architecture", ...input }, env);
    assert.deepEqual(
      [selection.model, selection.reasoningEffort, selection.tier, selection.source],
      [model, reasoningEffort, input.taskTier, "tier"]
    );
  }
  const inferred = selectCodexModelAndEffort({ prompt: "Summarize this", taskTier: "auto" }, env);
  assert.deepEqual([inferred.model, inferred.reasoningEffort, inferred.tier, inferred.source],
    ["gpt-6-luna", "medium", "quick", "auto"]);
});

test("Codex discovers newer family winners and falls back when families are absent", async (t) => {
  const env = await createTestCodexHome(t, codexCacheFixture);
  const select = (taskTier: CodexSelectionInput["taskTier"], hasInputImages = false) =>
    selectCodexModelAndEffort({ prompt: "Check this", taskTier, hasInputImages }, env);
  const cachePath = path.join(env.CODEX_HOME, "models_cache.json");
  assert.equal(select("standard").model, "gpt-6.2-sol");
  await fs.writeFile(cachePath, JSON.stringify({
    models: [...codexCacheFixture, { slug: "gpt-6.3-sol", visibility: "list", priority: 1 }],
  }));
  assert.equal(select("standard").model, "gpt-6.3-sol");

  await fs.writeFile(cachePath, JSON.stringify({ models: [
    { slug: "gpt-other", visibility: "list", priority: 0 },
    { slug: "gpt-old-SOL", visibility: "list", priority: 1, description: "Legacy model" },
    { slug: "gpt-older-sol", visibility: "list", priority: 2, upgrade: {} },
  ] }));
  const quick = select("quick");
  assert.deepEqual([quick.model, quick.reasoningEffort], ["gpt-old-SOL", "low"]);
  const frontier = select("frontier");
  assert.deepEqual([frontier.model, frontier.reasoningEffort], ["gpt-old-SOL", "high"]);
  assert.equal(select("standard", true).model, "gpt-old-SOL");

  await fs.writeFile(cachePath, '{"models":[{"slug":"gpt-other","visibility":"list"}]}');
  const fallback = select("quick");
  assert.deepEqual([fallback.model, fallback.reasoningEffort], ["gpt-other", "low"]);
});

test("Codex clamps automatic effort to a model's supported reasoning levels", async (t) => {
  const env = await createTestCodexHome(t, [
    ...codexCacheFixture,
    { slug: "gpt-custom", visibility: "list", default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }] },
  ]);
  const models = readCodexModelsCache(env);
  const sol = models?.find((model) => model.slug === "gpt-6.2-sol");
  assert.ok(sol);
  assert.equal(clampReasoningEffort("ultra", sol), "max");
  assert.equal(clampReasoningEffort("medium", sol), "medium");
  assert.equal(clampReasoningEffort("minimal", sol), "medium");
  assert.equal(clampReasoningEffort("minimal", { ...sol, default_reasoning_level: "HIGH" }), "low");
  assert.equal(clampReasoningEffort("minimal", {
    slug: "gpt-custom",
    supported_reasoning_levels: [{ effort: "LOW" }],
  }), "minimal");
  const selection = selectCodexModelAndEffort({
    prompt: "Check this", model: "gpt-custom", taskTier: "standard", hasInputImages: true,
  }, env);
  assert.deepEqual([selection.model, selection.reasoningEffort, selection.source],
    ["gpt-custom", "low", "explicit"]);
});

test("Codex honors explicit options, environment overrides, and the auto-selection switch", async (t) => {
  const env = await createTestCodexHome(t, codexCacheFixture);
  const select = (
    input: Partial<CodexSelectionInput>,
    overrides: NodeJS.ProcessEnv = {}
  ) => {
    const { model, reasoningEffort, tier, source } = selectCodexModelAndEffort(
      { prompt: "Review architecture", ...input }, { ...env, ...overrides }
    );
    return [model, reasoningEffort, tier, source];
  };
  const pair = { CODEX_MODEL: " env-model ", CODEX_REASONING_EFFORT: "max" };
  assert.deepEqual(select({ model: " explicit-model ", reasoningEffort: "ultra", taskTier: "quick" }, pair),
    ["explicit-model", "ultra", undefined, "explicit"]);
  assert.deepEqual(select({ model: "explicit-model" }, pair), ["explicit-model", "max", undefined, "explicit"]);
  assert.deepEqual(select({ reasoningEffort: "minimal" }, pair), ["env-model", "minimal", undefined, "explicit"]);
  assert.deepEqual(select({ taskTier: "quick" }, pair), ["env-model", "max", undefined, "env"]);
  assert.deepEqual(select({ taskTier: "quick" }, { CODEX_MODEL: "custom-model" }),
    ["custom-model", "medium", "quick", "env"]);
  assert.deepEqual(select({ taskTier: "standard" }, { CODEX_REASONING_EFFORT: "ultra" }),
    ["gpt-6.2-sol", "ultra", "standard", "env"]);
  assert.deepEqual(select({ taskTier: "standard" }, { CODEX_REASONING_EFFORT: "invalid" }),
    ["gpt-6.2-sol", "medium", "standard", "tier"]);
  assert.deepEqual(select({ isResume: true, taskTier: "auto" }), [undefined, undefined, undefined, "default"]);
  assert.deepEqual(select({ isResume: true, taskTier: "deep" }), ["gpt-6.2-sol", "high", "deep", "tier"]);
  assert.deepEqual(select({ isResume: true }, pair), ["env-model", "max", undefined, "env"]);
  assert.deepEqual(select({ taskTier: "frontier" }, { CODEX_AUTO_SELECT: "0" }),
    [undefined, undefined, undefined, "default"]);
  assert.deepEqual(select({ model: "explicit-model" }, { CODEX_AUTO_SELECT: "0" }),
    ["explicit-model", undefined, undefined, "explicit"]);
  assert.deepEqual(select({}, { CODEX_REASONING_EFFORT: "high", CODEX_AUTO_SELECT: "FALSE" }),
    [undefined, "high", undefined, "env"]);
});

test("offload_task applies Codex model selection to SDK options and reports effort and tier", async (t) => {
  const starts: Array<ThreadOptions | undefined> = [];
  const resumes: Array<{ id: string; options: ThreadOptions | undefined }> = [];
  const codexFactory: CodexClientFactory = () => ({
    startThread(options) {
      starts.push(options);
      return thread;
    },
    resumeThread(id, options) {
      resumes.push({ id, options });
      return thread;
    },
  });
  const thread = {
    id: "thr_pareto",
    async run() {
      return { finalResponse: "Done.", items: [], usage: null };
    },
  };
  const client = await connectTestClient(t, {
    env: await createTestCodexHome(t, codexCacheFixture),
    codexFactory,
  });
  const offload = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "offload_task",
      arguments: { provider: "codex", prompt: "Check the files", ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return (result.content as Array<{ text: string }>)[0].text.split("\n", 1)[0];
  };

  const inferred = await offload({ file_paths: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(starts[0]?.model, "gpt-6.2-sol");
  assert.equal(starts[0]?.modelReasoningEffort, "high");
  assert.equal(inferred, "[provider=codex | model=gpt-6.2-sol | thread=thr_pareto | focus_files=6 | effort=high | tier=deep]");

  const explicitTier = await offload({ task_tier: "quick", codex_sandbox: "workspace-write" });
  assert.equal(starts[1]?.model, "gpt-6.2-sol");
  assert.equal(starts[1]?.modelReasoningEffort, "low");
  assert.equal(explicitTier, "[provider=codex | model=gpt-6.2-sol | thread=thr_pareto | effort=low | tier=quick]");

  const explicitEffort = await offload({ codex_reasoning_effort: "ultra" });
  assert.equal(starts[2]?.model, "gpt-6.2-sol");
  assert.equal(starts[2]?.modelReasoningEffort, "ultra");
  assert.equal(explicitEffort, "[provider=codex | model=gpt-6.2-sol | thread=thr_pareto | effort=ultra | tier=standard]");

  const resumed = await offload({ thread_id: "thr_pareto", prompt: "Review architecture" });
  assert.equal(resumes[0]?.id, "thr_pareto");
  assert.equal(resumes[0]?.options?.model, undefined);
  assert.equal(resumes[0]?.options?.modelReasoningEffort, undefined);
  assert.equal(resumed, "[provider=codex | model=chatgpt-subscription-default | thread=thr_pareto]");
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


test("Codex runStreamed soft-timeout aborts cleanly and returns partial progress with threadId", async () => {
  const codexFactory: CodexClientFactory = () => ({
    startThread: () => ({
      id: null,
      async run() {
        throw new Error("should use runStreamed");
      },
      async runStreamed(_input, turnOptions) {
        return {
          events: (async function* () {
            yield { type: "thread.started" as const, thread_id: "thr_stream_partial" };
            yield {
              type: "item.completed" as const,
              item: {
                id: "item_1",
                type: "file_change" as const,
                status: "completed" as const,
                changes: [{ kind: "update" as const, path: "src/app.ts" }],
              },
            };
            yield {
              type: "item.completed" as const,
              item: {
                id: "item_2",
                type: "command_execution" as const,
                command: "npm.cmd test",
                aggregated_output: "running",
                status: "completed" as const,
                exit_code: 0,
              },
            };
            await new Promise<void>((resolve) => {
              if (turnOptions?.signal?.aborted) return resolve();
              turnOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
        };
      },
    }),
    resumeThread: () => {
      throw new Error("unexpected resume");
    },
  });

  const res = await callCodexCompletion(
    {
      prompt: "Refactor everything",
      workingDirectory: process.cwd(),
      sandboxMode: "workspace-write",
      softTimeoutSeconds: 0.02,
    },
    {},
    codexFactory
  );

  assert.equal(res.partial, true);
  assert.equal(res.threadId, "thr_stream_partial");
  assert.deepEqual(res.changedFiles, ["update:src/app.ts"]);
  assert.deepEqual(res.commandsRun, ["npm.cmd test (exit=0)"]);
  assert.match(res.content, /thread_id="thr_stream_partial"/);
});

test("offload_task blocks HTTP fallback after Codex workspace-write mutates workspace", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "offload-dirty-guard-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "target.ts"), "export const a = 1;\n");

  let httpCalled = false;
  const codexFactory: CodexClientFactory = () => ({
    startThread: () => ({
      id: "thr_dirty",
      async run() {
        throw new Error("should use runStreamed");
      },
      async runStreamed() {
        return {
          events: (async function* () {
            yield { type: "thread.started" as const, thread_id: "thr_dirty" };
            yield {
              type: "item.completed" as const,
              item: {
                id: "fc_1",
                type: "file_change" as const,
                status: "completed" as const,
                changes: [{ kind: "update" as const, path: "target.ts" }],
              },
            };
            yield { type: "turn.failed" as const, error: { message: "mid-turn crash" } };
          })(),
        };
      },
    }),
    resumeThread: () => {
      throw new Error("unexpected resume");
    },
  });

  const client = await connectTestClient(t, {
    env: { CODEX_API_KEY: "codex-key", DEEPSEEK_API_KEY: "ds-key" },
    codexFactory,
    fetchFn: async () => {
      httpCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "nope" } }] }), {
        status: 200,
      });
    },
  });

  const result = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      codex_sandbox: "workspace-write",
      workspace_dir: workspace,
      file_paths: ["target.ts"],
      prompt: "Edit target",
    },
  });

  assert.equal(result.isError, true);
  assert.equal(httpCalled, false);
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.match(text, /automatic fallback to HTTP providers is blocked/i);
  assert.match(text, /thread_id=thr_dirty/);
});

test("offload_task enforces allowed_files scope boundary in writeModeNote and falls back to focus_files above cap", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "offload-scope-cap-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "a.ts"), "x".repeat(200));

  const prompts: string[] = [];
  const codexFactory: CodexClientFactory = () => ({
    startThread: () => ({
      id: "thr_scope",
      async run(input) {
        prompts.push(typeof input === "string" ? input : "");
        return { finalResponse: "Done.", items: [], usage: null };
      },
    }),
    resumeThread: () => {
      throw new Error("unexpected resume");
    },
  });

  const client = await connectTestClient(t, {
    env: { CODEX_API_KEY: "codex-key", CODEX_EMBED_MAX_BYTES: "50" },
    codexFactory,
  });

  const res = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      codex_sandbox: "workspace-write",
      workspace_dir: workspace,
      file_paths: ["a.ts", "new_file.ts"],
      allowed_files: ["a.ts"],
      prompt: "Update a.ts",
    },
  });

  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const text = (res.content as Array<{ text: string }>)[0].text;
  assert.match(text, /focus_files=2/);
  assert.match(prompts[0], /Focus workspace files \(read directly from disk as needed\): a\.ts, new_file\.ts/);
  assert.match(prompts[0], /Do not modify files outside \[a\.ts\]/);
  assert.match(prompts[0], /Never invent parallel database tables/);
});

test("offload_task git_diff_base attaches hunk-scoped git diff and rejects flag-like base refs", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "offload-git-diff-"));
  t.after(() => fs.rm(repoDir, { recursive: true, force: true }));

  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, "svc.ts"), "export function oldFn() {}\n");
  await execFileAsync("git", ["add", "svc.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repoDir });
  const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });

  await fs.writeFile(
    path.join(repoDir, "svc.ts"),
    "export function oldFn() {}\nexport function newFn() { return 1; }\n"
  );
  await execFileAsync("git", ["add", "svc.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "feat"], { cwd: repoDir });

  let capturedPrompt = "";
  const client = await connectTestClient(t, {
    env: { CODEX_API_KEY: "codex-key" },
    codexFactory: () => ({
      startThread: () => ({
        id: "thr_diff",
        async run(input) {
          capturedPrompt = typeof input === "string" ? input : "";
          return { finalResponse: "PR summary ready.", items: [], usage: null };
        },
      }),
      resumeThread: () => {
        throw new Error("unexpected resume");
      },
    }),
  });

  const okRes = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      workspace_dir: repoDir,
      git_diff_base: baseSha.trim(),
      prompt: "Summarize PR changes",
    },
  });
  assert.notEqual(okRes.isError, true, JSON.stringify(okRes.content));
  assert.match(capturedPrompt, /\+export function newFn\(\)/);
  assert.match(capturedPrompt, /Cite ONLY files and symbols added \(\+\) or modified/);

  const badRes = await client.callTool({
    name: "offload_task",
    arguments: {
      provider: "codex",
      workspace_dir: repoDir,
      git_diff_base: "--output=/tmp/evil",
      prompt: "Summarize PR changes",
    },
  });
  assert.equal(badRes.isError, true);
  assert.match((badRes.content as Array<{ text: string }>)[0].text, /Invalid git_diff_base/);
});

test("CODEX_PREPEND_PATH prepends to cloned env PATH without wiping inherited env", async () => {
  const captured: Array<Record<string, string> | undefined> = [];
  const codexFactory: CodexClientFactory = (options) => {
    captured.push(options?.env);
    return {
      startThread: () => ({
        id: "thr_env",
        async run() {
          return { finalResponse: "ok", items: [], usage: null };
        },
      }),
      resumeThread: () => {
        throw new Error("unexpected resume");
      },
    };
  };

  await callCodexCompletion(
    { prompt: "Check", workingDirectory: process.cwd() },
    { CODEX_PREPEND_PATH: "C:\\hermes\\node", CUSTOM_KEEP: "yes" },
    codexFactory
  );

  assert.ok(captured[0]);
  const pathKey = Object.keys(captured[0]).find((k) => k.toLowerCase() === "path");
  assert.ok(pathKey);
  assert.ok(captured[0][pathKey].startsWith(`C:\\hermes\\node${path.delimiter}`));
  assert.equal(captured[0].CUSTOM_KEEP, "yes");
});
