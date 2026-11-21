import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Codex,
  type CodexOptions,
  type CommandExecutionItem,
  type FileChangeItem,
  type Input,
  type ModelReasoningEffort,
  type ReasoningItem,
  type RunResult,
  type SandboxMode,
  type ThreadItem,
  type ThreadOptions,
  type UserInput,
} from "@openai/codex-sdk";
import type { OffloadResponse } from "./providers.js";

export interface CodexOffloadParams {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  workingDirectory: string;
  threadId?: string;
  sandboxMode?: SandboxMode;
  reasoningEffort?: ModelReasoningEffort;
  includeReasoning?: boolean;
  inputImages?: string[];
}

export interface CodexImageParams {
  prompt: string;
  model?: string;
  workingDirectory: string;
  threadId?: string;
  inputImages?: string[];
}

export interface CodexThreadLike {
  readonly id: string | null;
  run(input: Input): Promise<RunResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options?: CodexOptions) => CodexClientLike;

export function getCodexAuthStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; detail: string } {
  if (env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) {
    return { configured: true, detail: "configured (API key)" };
  }

  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  if (fs.existsSync(authPath)) {
    return { configured: true, detail: "configured (ChatGPT login)" };
  }

  return {
    configured: false,
    detail: "not logged in (run 'npm run codex-login' or 'codex login')",
  };
}

function defaultCodexFactory(options?: CodexOptions): CodexClientLike {
  return new Codex(options);
}

function buildCodexInput(text: string, inputImages?: string[]): Input {
  if (!inputImages || inputImages.length === 0) {
    return text;
  }
  const entries: UserInput[] = [{ type: "text", text }];
  for (const imgPath of inputImages) {
    entries.push({ type: "local_image", path: imgPath });
  }
  return entries;
}

export async function callCodexCompletion(
  params: CodexOffloadParams,
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: CodexClientFactory = defaultCodexFactory
): Promise<
  OffloadResponse & {
    threadId?: string;
    changedFiles?: string[];
    commandsRun?: string[];
  }
> {
  const apiKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const codexOptions: CodexOptions = {};
  if (apiKey) {
    codexOptions.apiKey = apiKey;
  }

  const sandboxMode = params.sandboxMode ?? "read-only";
  if (process.platform === "win32" && sandboxMode === "workspace-write") {
    codexOptions.config = {
      features: { prefer_mxc: true },
      windows: { sandbox: env.CODEX_WINDOWS_SANDBOX?.trim() || "unelevated" },
    };
  }
  const threadOptions: ThreadOptions = {
    workingDirectory: params.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy: "never",
  };

  if (params.model?.trim()) {
    threadOptions.model = params.model.trim();
  }
  if (params.reasoningEffort) {
    threadOptions.modelReasoningEffort = params.reasoningEffort;
  }

  const writeModeNote =
    sandboxMode === "workspace-write" || sandboxMode === "danger-full-access"
      ? "\n\nExecution rules: Edit files directly in the workspace and run relevant checks. Reply with ONLY a concise summary (changed file paths and check results), without pasting full file contents."
      : "";

  const fullPrompt = params.systemPrompt?.trim()
    ? `System instructions:\n${params.systemPrompt.trim()}${writeModeNote}\n\nTask:\n${params.prompt}`
    : `${params.prompt}${writeModeNote}`;

  try {
    const client = clientFactory(codexOptions);
    const thread = params.threadId?.trim()
      ? client.resumeThread(params.threadId.trim(), threadOptions)
      : client.startThread(threadOptions);

    const turn = await thread.run(buildCodexInput(fullPrompt, params.inputImages));
    const reasoningParts = params.includeReasoning
      ? turn.items
          .filter(
            (item: ThreadItem): item is ReasoningItem =>
              item.type === "reasoning"
          )
          .map((item: ReasoningItem) => item.text)
      : [];

    const changedFiles = turn.items
      .filter(
        (item: ThreadItem): item is FileChangeItem =>
          item.type === "file_change" && item.status === "completed"
      )
      .flatMap((item: FileChangeItem) =>
        item.changes.map((c) => `${c.kind}:${c.path}`)
      );

    const commandsRun = turn.items
      .filter(
        (item: ThreadItem): item is CommandExecutionItem =>
          item.type === "command_execution"
      )
      .map(
        (item: CommandExecutionItem) =>
          `${item.command} (exit=${item.exit_code ?? item.status})`
      );

    const content = turn.finalResponse?.trim() ?? "";
    if (!content && reasoningParts.length === 0) {
      throw new Error("Codex returned an empty response.");
    }

    return {
      provider: "codex",
      model: params.model?.trim() || "chatgpt-subscription-default",
      content,
      reasoning:
        reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
      threadId: thread.id ?? undefined,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
      commandsRun: commandsRun.length > 0 ? commandsRun : undefined,
      usage: turn.usage
        ? {
            prompt_tokens: turn.usage.input_tokens,
            completion_tokens: turn.usage.output_tokens,
            total_tokens: turn.usage.input_tokens + turn.usage.output_tokens,
          }
        : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not logged in|login|unauthorized|401|auth/i.test(msg)) {
      throw new Error(
        `Codex authentication failed: ${msg}. Run 'npm run codex-login' in "${path.resolve(".")}" (or 'codex login') to sign in with your ChatGPT/OpenAI subscription.`
      );
    }
    throw new Error(`Codex execution failed: ${msg}`);
  }
}

async function listGeneratedImagesInDir(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: Array<{ fullPath: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fsp.stat(fullPath);
      files.push({ fullPath, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.map((f) => f.fullPath);
  } catch {
    return [];
  }
}

function extractImagePathsFromText(text: string): string[] {
  const matches = text.match(
    /(?:[A-Za-z]:\\|\/)[^\s`"'<>|*?]+\.(?:png|jpe?g|webp)/gi
  );
  if (!matches) return [];
  const existing: string[] = [];
  for (const candidate of matches) {
    if (fs.existsSync(candidate) && !existing.includes(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

export async function generateCodexImage(
  params: CodexImageParams,
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: CodexClientFactory = defaultCodexFactory
): Promise<OffloadResponse & { threadId?: string; generatedImages: string[] }> {
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const priorImages = new Set<string>();
  if (params.threadId?.trim()) {
    const existing = await listGeneratedImagesInDir(
      path.join(codexHome, "generated_images", params.threadId.trim())
    );
    for (const p of existing) priorImages.add(p);
  }

  const trimmed = params.prompt.trim();
  const imagePrompt = trimmed.startsWith("$imagegen")
    ? trimmed
    : `$imagegen ${trimmed}`;

  const result = await callCodexCompletion(
    {
      prompt: imagePrompt,
      model: params.model,
      workingDirectory: params.workingDirectory,
      threadId: params.threadId,
      sandboxMode: "read-only",
      inputImages: params.inputImages,
    },
    env,
    clientFactory
  );

  let generatedImages: string[] = [];
  if (result.threadId) {
    const threadDir = path.join(codexHome, "generated_images", result.threadId);
    const allInDir = await listGeneratedImagesInDir(threadDir);
    generatedImages = allInDir.filter((p) => !priorImages.has(p));
  }

  if (generatedImages.length === 0 && result.content) {
    generatedImages = extractImagePathsFromText(result.content).filter(
      (p) => !priorImages.has(p)
    );
  }

  return {
    ...result,
    generatedImages,
  };
}
