import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  Codex,
  type AgentMessageItem,
  type CodexOptions,
  type CommandExecutionItem,
  type FileChangeItem,
  type Input,
  type ModelReasoningEffort,
  type ReasoningItem,
  type RunResult,
  type RunStreamedResult,
  type SandboxMode,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
  type UserInput,
} from "@openai/codex-sdk";
import { getCodexHome, selectCodexModelAndEffort, type CodexTaskTier } from "./codex-models.js";
import type { OffloadResponse } from "./providers.js";

export interface CodexOffloadParams {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  workingDirectory: string;
  threadId?: string;
  sandboxMode?: SandboxMode;
  reasoningEffort?: ModelReasoningEffort;
  taskTier?: CodexTaskTier;
  fileCount?: number;
  allowedFiles?: string[];
  softTimeoutSeconds?: number;
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
  run(input: Input, turnOptions?: TurnOptions): Promise<RunResult>;
  runStreamed?(input: Input, turnOptions?: TurnOptions): Promise<RunStreamedResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options?: CodexOptions) => CodexClientLike;

export class CodexExecutionError extends Error {
  readonly threadId?: string;
  readonly changedFiles: string[];
  readonly commandsRun: string[];

  constructor(
    message: string,
    details?: {
      threadId?: string;
      changedFiles?: string[];
      commandsRun?: string[];
    }
  ) {
    super(message);
    this.name = "CodexExecutionError";
    this.threadId = details?.threadId;
    this.changedFiles = details?.changedFiles ?? [];
    this.commandsRun = details?.commandsRun ?? [];
  }
}

export function getCodexAuthStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; detail: string } {
  if (env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) {
    return { configured: true, detail: "configured (API key)" };
  }

  const codexHome = getCodexHome(env);
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

function buildCodexEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const prepend = env.CODEX_PREPEND_PATH?.trim();
  if (!prepend) {
    return undefined;
  }
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") {
      merged[k] = v;
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      merged[k] = v;
    }
  }
  const pathKey = Object.keys(merged).find((k) => k.toLowerCase() === "path") ?? "PATH";
  merged[pathKey] = merged[pathKey] ? `${prepend}${path.delimiter}${merged[pathKey]}` : prepend;
  return merged;
}

function collectItemSummary(items: readonly ThreadItem[], includeReasoning?: boolean) {
  const reasoningParts = includeReasoning
    ? items
        .filter((item): item is ReasoningItem => item.type === "reasoning")
        .map((item) => item.text)
    : [];

  const changedFiles = items
    .filter(
      (item): item is FileChangeItem =>
        item.type === "file_change" && item.status === "completed"
    )
    .flatMap((item) => item.changes.map((c) => `${c.kind}:${c.path}`));

  const commandsRun = items
    .filter((item): item is CommandExecutionItem => item.type === "command_execution")
    .map((item) => `${item.command} (exit=${item.exit_code ?? item.status})`);

  return { reasoningParts, changedFiles, commandsRun };
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
    partial?: boolean;
  }
> {
  const apiKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const codexOptions: CodexOptions = {};
  if (apiKey) {
    codexOptions.apiKey = apiKey;
  }
  const codexEnv = buildCodexEnv(env);
  if (codexEnv) {
    codexOptions.env = codexEnv;
  }

  const sandboxMode = params.sandboxMode ?? "read-only";
  const selection = selectCodexModelAndEffort({
    prompt: params.prompt,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    taskTier: params.taskTier,
    sandboxMode,
    fileCount: params.fileCount ?? 0,
    hasInputImages: Boolean(params.inputImages?.length),
    isResume: Boolean(params.threadId?.trim()),
  }, env);
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

  if (selection.model !== undefined) {
    threadOptions.model = selection.model;
  }
  if (selection.reasoningEffort !== undefined) {
    threadOptions.modelReasoningEffort = selection.reasoningEffort;
  }

  const allowsWrites =
    sandboxMode === "workspace-write" || sandboxMode === "danger-full-access";
  let writeModeNote = "";
  if (allowsWrites) {
    const scopeRule = params.allowedFiles?.length
      ? `\nScope boundary: Do not modify files outside [${params.allowedFiles.join(", ")}] unless strictly required by a broken import or test. Never invent parallel database tables, stores, or services when canonical ones exist in the repo.`
      : `\nScope boundary: Keep edits tightly scoped to the requested task; never invent parallel database tables, stores, or services when canonical ones exist in the repo.`;
    const windowsNote =
      process.platform === "win32"
        ? `\nWindows environment: Use npm.cmd instead of npm.ps1 to avoid PowerShell ExecutionPolicy blocks; if a git worktree lacks node_modules, check the main repo or link it before giving up on builds/tests.`
        : "";
    writeModeNote =
      `\n\nExecution rules: Edit files directly in the workspace and run relevant checks. Reply with ONLY a concise summary (changed file paths and check results), without pasting full file contents.` +
      scopeRule +
      windowsNote;
  }

  const fullPrompt = params.systemPrompt?.trim()
    ? `System instructions:\n${params.systemPrompt.trim()}${writeModeNote}\n\nTask:\n${params.prompt}`
    : `${params.prompt}${writeModeNote}`;

  const rawTimeout =
    params.softTimeoutSeconds ??
    (env.CODEX_SOFT_TIMEOUT_SECONDS !== undefined
      ? Number(env.CODEX_SOFT_TIMEOUT_SECONDS)
      : 510);
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (Number.isFinite(rawTimeout) && rawTimeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, rawTimeout * 1000);
  }

  let currentThreadId: string | undefined = params.threadId?.trim() || undefined;
  const itemsById = new Map<string, ThreadItem>();
  const orderedIds: string[] = [];
  let finalResponse = "";
  let usage: Usage | null = null;

  const upsertItem = (item: ThreadItem) => {
    if (!itemsById.has(item.id)) {
      orderedIds.push(item.id);
    }
    itemsById.set(item.id, item);
    if (item.type === "agent_message") {
      finalResponse = (item as AgentMessageItem).text;
    }
  };

  try {
    const client = clientFactory(codexOptions);
    const thread = params.threadId?.trim()
      ? client.resumeThread(params.threadId.trim(), threadOptions)
      : client.startThread(threadOptions);
    currentThreadId = thread.id ?? currentThreadId;

    const input = buildCodexInput(fullPrompt, params.inputImages);

    if (typeof thread.runStreamed === "function") {
      try {
        const streamed = await thread.runStreamed(input, { signal: controller.signal });
        for await (const event of streamed.events) {
          if (event.type === "thread.started") {
            currentThreadId = event.thread_id;
          } else if (
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
          ) {
            upsertItem(event.item);
          } else if (event.type === "turn.completed") {
            usage = event.usage;
          } else if (event.type === "turn.failed") {
            throw new Error(event.error.message || "Codex turn failed");
          } else if (event.type === "error") {
            throw new Error(event.message || "Codex stream error");
          }
          if (thread.id) {
            currentThreadId = thread.id;
          }
        }
      } catch (streamErr) {
        if (!timedOut) {
          throw streamErr;
        }
      }
    } else {
      try {
        const turn = await thread.run(input, { signal: controller.signal });
        currentThreadId = thread.id ?? currentThreadId;
        for (const item of turn.items) {
          upsertItem(item);
        }
        finalResponse = turn.finalResponse;
        usage = turn.usage;
      } catch (runErr) {
        if (!timedOut) {
          throw runErr;
        }
      }
    }

    currentThreadId = thread.id ?? currentThreadId;
    const collectedItems = orderedIds.map((id) => itemsById.get(id)!);
    const { reasoningParts, changedFiles, commandsRun } = collectItemSummary(
      collectedItems,
      params.includeReasoning
    );

    if (timedOut) {
      const resumeHint = currentThreadId
        ? ` Resume with thread_id="${currentThreadId}" to continue.`
        : "";
      const partialContent =
        finalResponse.trim() ||
        `[Soft timeout after ${rawTimeout}s] Codex hit the soft deadline before completing its turn.${resumeHint}`;
      return {
        provider: "codex",
        model: selection.model || "chatgpt-subscription-default",
        reasoningEffort: selection.reasoningEffort,
        selectionTier: selection.tier,
        partial: true,
        content: partialContent,
        reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
        threadId: currentThreadId,
        changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
        commandsRun: commandsRun.length > 0 ? commandsRun : undefined,
        usage: usage
          ? {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              total_tokens: usage.input_tokens + usage.output_tokens,
            }
          : undefined,
      };
    }

    const content = finalResponse.trim();
    if (!content && reasoningParts.length === 0) {
      throw new Error("Codex returned an empty response.");
    }

    return {
      provider: "codex",
      model: selection.model || "chatgpt-subscription-default",
      reasoningEffort: selection.reasoningEffort,
      selectionTier: selection.tier,
      content,
      reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
      threadId: currentThreadId,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
      commandsRun: commandsRun.length > 0 ? commandsRun : undefined,
      usage: usage
        ? {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
          }
        : undefined,
    };
  } catch (err) {
    const collectedItems = orderedIds.map((id) => itemsById.get(id)!);
    const { changedFiles, commandsRun } = collectItemSummary(collectedItems, false);
    const msg = err instanceof Error ? err.message : String(err);
    const details = { threadId: currentThreadId, changedFiles, commandsRun };
    if (/not logged in|login|unauthorized|401|auth/i.test(msg)) {
      throw new CodexExecutionError(
        `Codex authentication failed: ${msg}. Run 'npm run codex-login' in "${path.resolve(".")}" (or 'codex login') to sign in with your ChatGPT/OpenAI subscription.`,
        details
      );
    }
    throw new CodexExecutionError(`Codex execution failed: ${msg}`, details);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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
  const codexHome = getCodexHome(env);
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
