#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  copyFileToWorkspace,
  readWorkspaceFiles,
  resolveWithinWorkspace,
  resolveWorkspaceInputFiles,
  writeWorkspaceFile,
} from "./files.js";
import {
  CodexExecutionError,
  callCodexCompletion,
  generateCodexImage,
  getCodexAuthStatus,
  type CodexClientFactory,
} from "./codex.js";
import {
  CODEX_REASONING_EFFORTS,
  CODEX_TASK_TIERS,
  extractCodexSkillMentions,
  findMissingCodexSkills,
  getCodexHome,
  readCodexModelsCache,
} from "./codex-models.js";
import {
  callChatCompletion,
  fetchProviderModels,
  getFallbackChain,
  getProviderConfigs,
  resolveApiKey,
  resolveProviderId,
  type ChatMessage,
  type OffloadResponse,
} from "./providers.js";

export { findMissingCodexSkills } from "./codex-models.js";

const execFileAsync = promisify(execFile);

export interface ServerDeps {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  codexFactory?: CodexClientFactory;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an expert software engineering worker. Return accurate, concise, directly usable code, patches, or analysis.";

async function getGitStatusPorcelain(workspaceDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspaceDir,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function getGitDiff(
  workspaceDir: string,
  baseRef: string,
  maxBytes: number = 256 * 1024
): Promise<{ diffText: string; truncated: boolean; bytes: number }> {
  const ref = baseRef.trim();
  if (!ref || ref.startsWith("-")) {
    throw new Error(`Invalid git_diff_base "${baseRef}".`);
  }
  const { stdout } = await execFileAsync("git", ["diff", `${ref}...HEAD`], {
    cwd: workspaceDir,
    maxBuffer: maxBytes * 4,
  });
  const totalBytes = Buffer.byteLength(stdout, "utf8");
  if (totalBytes > maxBytes) {
    const sliced = Buffer.from(stdout, "utf8").subarray(0, maxBytes).toString("utf8");
    return { diffText: sliced, truncated: true, bytes: Buffer.byteLength(sliced, "utf8") };
  }
  return { diffText: stdout, truncated: false, bytes: totalBytes };
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const codexFactory = deps.codexFactory;

  const server = new McpServer({
    name: "antigravity-offload-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "offload_task",
    {
      title: "Offload Task to OpenCode / DeepSeek / Codex",
      description:
        "Offload heavy code generation, refactoring, debugging, or log/file analysis to OpenCode Console (opencode / opencode-go), DeepSeek API, or OpenAI Codex CLI (ChatGPT subscription). Pass file_paths so this server reads workspace files locally without burning Antigravity tokens.",
      inputSchema: {
        prompt: z.string().min(1).describe("Task instruction for the external model."),
        provider: z
          .enum(["opencode", "opencode-go", "deepseek", "codex"])
          .optional()
          .describe(
            "Target provider: 'opencode' (Console pay-as-you-go), 'opencode-go' (Go subscription), 'deepseek' (api.deepseek.com), or 'codex' (OpenAI Codex CLI / ChatGPT subscription)."
          ),
        allow_fallback: z
          .boolean()
          .optional()
          .describe("Allow automatic fallback to other configured providers when the primary fails (default: true)."),
        model: z
          .string()
          .optional()
          .describe(
            "Model ID (e.g. 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4.1-flash', 'kimi-k3'). For Codex, omit to enable auto-Pareto model selection."
          ),
        file_paths: z
          .array(z.string())
          .optional()
          .describe(
            "Workspace-relative (or contained) file paths to read locally and include as context."
          ),
        allowed_files: z
          .array(z.string())
          .optional()
          .describe(
            "Optional workspace-relative file paths Codex is allowed to edit in write mode. Defaults to file_paths when provided."
          ),
        git_diff_base: z
          .string()
          .optional()
          .describe(
            "Optional git base ref (e.g. 'origin/main') to attach 'git diff <base>...HEAD' directly as context with strict hunk-only scoping."
          ),
        workspace_dir: z
          .string()
          .optional()
          .describe("Base directory for file_paths and output_file. Defaults to cwd."),
        output_file: z
          .string()
          .optional()
          .describe(
            "Optional file path inside workspace_dir to write the model output to disk."
          ),
        system_prompt: z
          .string()
          .optional()
          .describe("Optional system prompt override."),
        session_id: z
          .string()
          .optional()
          .describe("Optional stable OpenCode session ID (ses_...) for cache routing."),
        thread_id: z
          .string()
          .optional()
          .describe("Optional Codex thread ID to resume a previous Codex conversation."),
        codex_sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional()
          .describe("Codex sandbox mode (default: 'read-only')."),
        codex_reasoning_effort: z
          .enum(CODEX_REASONING_EFFORTS)
          .optional()
          .describe("Codex reasoning effort override."),
        task_tier: z
          .enum(CODEX_TASK_TIERS)
          .optional()
          .describe("Codex auto-Pareto routing tier. Use 'auto' (default) to infer the tier from the task, or choose 'quick', 'standard', 'deep', or 'frontier'."),
        input_images: z
          .array(z.string())
          .optional()
          .describe("Optional workspace image paths to attach (Codex provider only)."),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().optional(),
        include_reasoning: z
          .boolean()
          .optional()
          .describe("Include reasoning_content in output when returned by reasoning models."),
      },
    },
    async (args) => {
      try {
        const workspaceDir = args.workspace_dir || process.cwd();
        const resolvedProvider = resolveProviderId(args.provider, env);

        const incompatibleCodexOutput =
          args.output_file &&
          (args.codex_sandbox === "workspace-write" ||
            args.codex_sandbox === "danger-full-access");
        const codexOutputError =
          `Do not combine output_file with codex_sandbox="${args.codex_sandbox}"; Codex writes files directly and output_file would overwrite "${args.output_file}" with Codex's summary.`;
        if (resolvedProvider === "codex" && incompatibleCodexOutput) {
          throw new Error(codexOutputError);
        }

        let gitDiffText = "";
        let gitDiffSummary = "";
        if (args.git_diff_base?.trim()) {
          const baseRef = args.git_diff_base.trim();
          const diffRes = await getGitDiff(workspaceDir, baseRef);
          const truncNote = diffRes.truncated ? "\n...[diff truncated at byte limit]" : "";
          gitDiffText = diffRes.diffText.trim()
            ? `\n\nAttached git diff (${baseRef}...HEAD):\n\`\`\`diff\n${diffRes.diffText}${truncNote}\n\`\`\`\n\nDiff scope rule: Cite ONLY files and symbols added (+) or modified in the diff hunks above. Do not list pre-existing unchanged symbols from surrounding files.`
            : `\n\nAttached git diff (${baseRef}...HEAD): (empty diff — no changes against ${baseRef})`;
          gitDiffSummary = ` | git_diff=${baseRef}...HEAD (${diffRes.bytes} bytes)`;
        }

        const chain = getFallbackChain(resolvedProvider, env, args.allow_fallback);
        const failures: string[] = [];
        let firstErrorShort = "";
        let result: OffloadResponse | undefined;
        let attachedSummary = "";

        for (const candidate of chain) {
          const isCodexWrite =
            candidate === "codex" &&
            (args.codex_sandbox === "workspace-write" ||
              args.codex_sandbox === "danger-full-access");
          let preGitStatus: string | null = null;

          try {
            if (candidate !== "codex" && args.input_images?.length) {
              throw new Error("HTTP providers do not support input_images");
            }
            if (candidate === "codex" && incompatibleCodexOutput) {
              throw new Error(codexOutputError);
            }

            attachedSummary = "";
            const model = candidate === resolvedProvider ? args.model : undefined;
            let userContent = args.prompt;

            if (args.file_paths && args.file_paths.length > 0) {
              if (candidate === "codex") {
                const resolvedEntries = args.file_paths.map((p) =>
                  resolveWithinWorkspace(workspaceDir, p)
                );
                const existingRelPaths: string[] = [];
                const missingRelPaths: string[] = [];
                let existingBytes = 0;

                for (const entry of resolvedEntries) {
                  try {
                    const stat = await fsp.stat(entry.absPath);
                    if (!stat.isFile()) {
                      throw new Error(`"${entry.relPath}" is not a regular file.`);
                    }
                    existingRelPaths.push(entry.relPath);
                    existingBytes += stat.size;
                  } catch (statErr) {
                    if ((statErr as NodeJS.ErrnoException)?.code === "ENOENT") {
                      missingRelPaths.push(entry.relPath);
                    } else {
                      throw statErr;
                    }
                  }
                }

                const codexEmbedMaxBytes =
                  Number(env.CODEX_EMBED_MAX_BYTES) || 64 * 1024;
                if (existingRelPaths.length > 0 && existingBytes <= codexEmbedMaxBytes) {
                  const loaded = await readWorkspaceFiles(
                    workspaceDir,
                    existingRelPaths,
                    codexEmbedMaxBytes
                  );
                  userContent = `${args.prompt}\n\nAttached workspace files (already loaded in context — do not re-read via shell unless verifying edits):\n\n${loaded.contextText}`;
                  if (missingRelPaths.length > 0) {
                    userContent += `\n\nTarget files to create: ${missingRelPaths.join(", ")}`;
                  }
                  attachedSummary = ` | files=${loaded.loadedFiles.length} (${loaded.totalBytes} bytes)`;
                } else {
                  const relPaths = resolvedEntries.map((e) => e.relPath);
                  userContent = `${args.prompt}\n\nFocus workspace files (read directly from disk as needed): ${relPaths.join(", ")}`;
                  attachedSummary = ` | focus_files=${relPaths.length}`;
                }
              } else {
                const loaded = await readWorkspaceFiles(workspaceDir, args.file_paths);
                userContent = `${args.prompt}\n\nAttached workspace files:\n\n${loaded.contextText}`;
                attachedSummary = ` | files=${loaded.loadedFiles.length} (${loaded.totalBytes} bytes)`;
              }
            }

            if (gitDiffText) {
              userContent += gitDiffText;
              attachedSummary += gitDiffSummary;
            }

            if (candidate === "codex") {
              const resolvedInputImages =
                args.input_images && args.input_images.length > 0
                  ? (await resolveWorkspaceInputFiles(workspaceDir, args.input_images)).map(
                      (f) => f.absPath
                    )
                  : undefined;
              const allowedFiles = isCodexWrite
                ? (args.allowed_files ?? args.file_paths)?.map(
                    (p) => resolveWithinWorkspace(workspaceDir, p).relPath
                  )
                : undefined;

              if (isCodexWrite) {
                preGitStatus = await getGitStatusPorcelain(workspaceDir);
              }

              result = await callCodexCompletion(
                {
                  prompt: userContent,
                  systemPrompt: args.system_prompt,
                  model,
                  workingDirectory: workspaceDir,
                  threadId: args.thread_id,
                  sandboxMode: args.codex_sandbox,
                  reasoningEffort: args.codex_reasoning_effort,
                  taskTier: args.task_tier,
                  fileCount: args.file_paths?.length ?? 0,
                  allowedFiles,
                  includeReasoning: args.include_reasoning,
                  inputImages: resolvedInputImages,
                },
                env,
                codexFactory
              );
            } else {
              const messages: ChatMessage[] = [
                {
                  role: "system",
                  content: args.system_prompt || DEFAULT_SYSTEM_PROMPT,
                },
                { role: "user", content: userContent },
              ];

              result = await callChatCompletion(
                {
                  provider: candidate,
                  model,
                  messages,
                  sessionId: args.session_id,
                  temperature: args.temperature,
                  maxTokens: args.max_tokens,
                  includeReasoning: args.include_reasoning,
                },
                env,
                fetchFn
              );
            }
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            if (isCodexWrite) {
              const postGitStatus = await getGitStatusPorcelain(workspaceDir);
              const gitChanged =
                preGitStatus !== null &&
                postGitStatus !== null &&
                postGitStatus !== preGitStatus;
              const codexMutated =
                err instanceof CodexExecutionError &&
                (err.changedFiles.length > 0 || err.commandsRun.length > 0);
              if (gitChanged || codexMutated) {
                const threadHint =
                  err instanceof CodexExecutionError && err.threadId
                    ? ` (thread_id=${err.threadId})`
                    : "";
                throw new Error(
                  `Codex write-mode failed after modifying workspace${threadHint}; automatic fallback to HTTP providers is blocked to prevent state corruption. Original error: ${message}`
                );
              }
            }

            failures.push(`${candidate}: ${message}`);
            if (failures.length === 1) {
              firstErrorShort = message.split(/\r?\n/, 1)[0].slice(0, 160);
            }
          }
        }

        if (!result) {
          throw new Error(`All providers failed:\n${failures.join("\n")}`);
        }

        const fallbackText = result.provider !== resolvedProvider
          ? ` | fallback_from=${resolvedProvider} (${firstErrorShort})`
          : "";
        const threadText = result.threadId ? ` | thread=${result.threadId}` : "";
        const partialText = result.partial ? " | partial=true" : "";
        const effortText = result.reasoningEffort !== undefined ? ` | effort=${result.reasoningEffort}` : "";
        const tierText = result.selectionTier !== undefined ? ` | tier=${result.selectionTier}` : "";
        const usageText = result.usage
          ? ` | tokens(in=${result.usage.prompt_tokens ?? "?"}, out=${result.usage.completion_tokens ?? "?"}, total=${result.usage.total_tokens ?? "?"})`
          : "";
        const header = `[provider=${result.provider} | model=${result.model}${threadText}${partialText}${attachedSummary}${effortText}${tierText}${usageText}${fallbackText}]`;
        const mentions = extractCodexSkillMentions(args.prompt);
        const missing = findMissingCodexSkills(args.prompt, env);
        const headerLines = [header];
        if (missing.length > 0) {
          headerLines.push(
            `Warning: Codex skill not found in ${path.join(getCodexHome(env), "skills")}: ${missing.map((s) => `$${s}`).join(", ")}`
          );
        }
        if (result.provider !== "codex" && mentions.length > 0) {
          headerLines.push("Note: $skill mentions only load with provider=codex.");
        }
        const responseHeader = headerLines.join("\n");

        if (args.output_file) {
          const writtenRel = await writeWorkspaceFile(
            workspaceDir,
            args.output_file,
            result.content
          );
          const preview = result.content.slice(0, 400);
          return {
            content: [
              {
                type: "text",
                text: `${responseHeader}\nWrote ${result.content.length} chars to "${writtenRel}".\n\nPreview:\n${preview}${result.content.length > 400 ? "\n...[truncated]" : ""}`,
              },
            ],
          };
        }

        const body = result.reasoning
          ? `<reasoning>\n${result.reasoning}\n</reasoning>\n\n${result.content}`
          : result.content;

        const codexDetails: string[] = [];
        if (result.changedFiles && result.changedFiles.length > 0) {
          codexDetails.push(`Changed files: ${result.changedFiles.join(", ")}`);
        }
        if (result.commandsRun && result.commandsRun.length > 0) {
          codexDetails.push(`Commands run: ${result.commandsRun.join(" ; ")}`);
        }
        const detailsBlock =
          codexDetails.length > 0 ? `\n${codexDetails.join("\n")}` : "";

        return {
          content: [{ type: "text", text: `${responseHeader}${detailsBlock}\n\n${body}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `offload_task failed: ${message}` }],
        };
      }
    }
  );

  server.registerTool(
    "list_offload_models",
    {
      title: "List Offload Models",
      description:
        "Fetch available models from OpenCode Console, OpenCode Go, DeepSeek, or Codex, and show configured auth status.",
      inputSchema: {
        provider: z
          .enum(["opencode", "opencode-go", "deepseek", "codex"])
          .optional()
          .describe("Provider to query. Defaults to active provider."),
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter for model ID or name."),
      },
    },
    async (args) => {
      try {
        const configs = getProviderConfigs(env);
        const statusLines = Object.values(configs).map((c) => {
          const configured = resolveApiKey(c, env) ? "configured" : "missing key";
          return `- ${c.id} (${c.label}): ${configured} | default=${c.defaultModel}`;
        });
        const codexStatus = getCodexAuthStatus(env);
        const codexDefault = readCodexModelsCache(env)?.length
          ? "auto-pareto (from models_cache.json)"
          : "chatgpt-subscription-default";
        statusLines.push(
          `- codex (OpenAI Codex CLI / ChatGPT Subscription): ${codexStatus.detail} | default=${codexDefault}`
        );

        const activeProvider = resolveProviderId(args.provider, env);
        const { provider, label, models } = await fetchProviderModels(
          activeProvider,
          args.filter,
          env,
          fetchFn
        );

        const modelLines = models
          .slice(0, 80)
          .map((m) => (m.name ? `- ${m.id} (${m.name})` : `- ${m.id}`));
        const truncatedNote =
          models.length > 80
            ? `\n...and ${models.length - 80} more (use 'filter' to narrow).`
            : "";

        return {
          content: [
            {
              type: "text",
              text: `Configured providers:\n${statusLines.join("\n")}\n\nModels from ${provider} (${label}) [${models.length} matched]:\n${modelLines.join("\n")}${truncatedNote}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `list_offload_models failed: ${message}` }],
        };
      }
    }
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image via Codex",
      description:
        "Generate or edit images using Codex's built-in $imagegen capability (gpt-image-2 via your ChatGPT subscription) and optionally copy the resulting PNG into workspace_dir.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("Detailed image generation or editing prompt."),
        output_file: z
          .string()
          .optional()
          .describe(
            "Optional workspace-relative path (e.g. 'assets/hero.png') to copy the generated image into."
          ),
        workspace_dir: z
          .string()
          .optional()
          .describe("Base directory for output_file and input_images. Defaults to cwd."),
        input_images: z
          .array(z.string())
          .optional()
          .describe(
            "Optional reference image paths inside workspace_dir to edit or guide generation."
          ),
        thread_id: z
          .string()
          .optional()
          .describe("Optional Codex thread ID to refine a previously generated image."),
        model: z.string().optional().describe("Optional Codex model override."),
      },
    },
    async (args) => {
      try {
        const workspaceDir = args.workspace_dir || process.cwd();
        const resolvedInputs =
          args.input_images && args.input_images.length > 0
            ? (await resolveWorkspaceInputFiles(workspaceDir, args.input_images)).map(
                (f) => f.absPath
              )
            : undefined;

        const result = await generateCodexImage(
          {
            prompt: args.prompt,
            model: args.model,
            workingDirectory: workspaceDir,
            threadId: args.thread_id,
            inputImages: resolvedInputs,
          },
          env,
          codexFactory
        );

        const copiedFiles: string[] = [];
        if (args.output_file && result.generatedImages.length > 0) {
          const parsed = path.parse(args.output_file);
          for (let i = 0; i < result.generatedImages.length; i += 1) {
            const targetName =
              i === 0
                ? args.output_file
                : path.join(parsed.dir, `${parsed.name}-${i + 1}${parsed.ext || ".png"}`);
            const copied = await copyFileToWorkspace(
              workspaceDir,
              result.generatedImages[i],
              targetName
            );
            copiedFiles.push(`${copied.relPath} (${copied.bytes} bytes)`);
          }
        }

        const threadText = result.threadId ? ` | thread=${result.threadId}` : "";
        const usageText = result.usage
          ? ` | tokens(in=${result.usage.prompt_tokens ?? "?"}, out=${result.usage.completion_tokens ?? "?"}, total=${result.usage.total_tokens ?? "?"})`
          : "";
        const header = `[provider=codex | tool=imagegen${threadText}${usageText}]`;

        const lines: string[] = [header];
        if (copiedFiles.length > 0) {
          lines.push(`Saved to workspace: ${copiedFiles.join(", ")}`);
        } else if (args.output_file) {
          lines.push(
            `Warning: output_file "${args.output_file}" requested, but no generated image file was detected automatically.`
          );
        }
        if (result.generatedImages.length > 0) {
          lines.push(`Generated artifacts: ${result.generatedImages.join(", ")}`);
        }
        if (result.content) {
          lines.push("", result.content);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `generate_image failed: ${message}` }],
        };
      }
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const current = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? current.toLowerCase() === invoked.toLowerCase()
    : current === invoked;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("Fatal MCP server error:", err);
    process.exit(1);
  });
}
