# Offload Worker (`antigravity-offload-mcp`)

A local stdio MCP server and Antigravity plugin that delegates token-heavy coding, multi-file refactoring, test generation, codebase audits, log/file analysis, and image generation to external providers while keeping Antigravity as a lightweight orchestrator.

## Features

- **Multi-Provider Routing & Automatic Fallback:** Routes tasks to OpenAI Codex (ChatGPT subscription or API key), OpenCode Go (subscription), OpenCode Console (pay-as-you-go), or the DeepSeek API, with automatic fallback across configured providers.
- **Pareto-Guided Codex Model & Effort Selection:** Reads `$CODEX_HOME/models_cache.json` dynamically and selects the best cost/intelligence `(model, reasoningEffort)` pair for each task tier (`quick`, `standard`, `deep`, `frontier`, and `vision` for image inputs), upgrading automatically when newer model versions appear.
- **Local File Context Without Token Bloat:** Passes workspace-relative `file_paths` as on-disk focus hints to Codex, or reads up to 512 KiB locally for HTTP providers with workspace path-traversal enforcement.
- **Stateful Thread & Session Continuity:** Preserves Codex `thread_id` across turns (without mutating cached model defaults on resume) and attaches `x-opencode-session` (`ses_...`) headers for OpenCode prompt cache routing.
- **Image Generation & Editing:** Exposes Codex `$imagegen` (`gpt-image-2`) through `generate_image`, supporting reference `input_images`, iterative `thread_id` refinement, and copying generated PNGs into the workspace.
- **Automatic Codex Skill Sync:** Links Antigravity skills (`~/.gemini/config/skills` and installed plugin `skills/` directories) into `$CODEX_HOME/skills` at MCP server startup via `sync-skills.cjs`.
  - Invoke synced skills natively via `$skill-name` in `offload_task` prompts; the server warns when a referenced skill is missing from `$CODEX_HOME/skills`.

---

## Requirements

- **Node.js** 20.6 or newer
- At least one configured provider:
  - **Codex:** Signed in via `npm run codex-login` (`codex login`) or `CODEX_API_KEY` / `OPENAI_API_KEY`
  - **OpenCode Go / Console:** `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY`
  - **DeepSeek:** `DEEPSEEK_API_KEY`

---

## Installation & Setup

### 1. Build the Server

```bash
npm install
npm run build
```

If using OpenAI Codex via a ChatGPT subscription, sign in once:

```bash
npm run codex-login
npm run codex-status
```

### 2. Install as an Antigravity Plugin (Optional Skill Sync)

Install or link this repository under `~/.gemini/config/plugins/offload-worker`. On MCP startup, `sync-skills.cjs` scans `~/.gemini/config/skills` first, then each installed plugin's `skills/` directory in alphabetical order, and links any folder containing `SKILL.md` into `$CODEX_HOME/skills` (default `~/.codex/skills`) using directory junctions on Windows and symlinks on macOS/Linux. Existing user entries in `$CODEX_HOME/skills` take precedence, and `.system` is reserved.

### 3. Configure `mcp_config.json`

Point Antigravity's `offload-worker` entry to `dist/src/index.js` and preload `sync-skills.cjs` if you want automatic skill linking on startup:

```json
{
  "mcpServers": {
    "offload-worker": {
      "command": "node",
      "args": [
        "--require",
        "/path/to/offload-worker/sync-skills.cjs",
        "/path/to/offload-worker/dist/src/index.js"
      ],
      "env": {
        "DEFAULT_OFFLOAD_PROVIDER": "codex",
        "OPENCODE_API_KEY": "your-opencode-key"
      },
      "timeoutSeconds": 600
    }
  }
}
```

On Windows, you can alternatively load `sync-skills.cjs` relative to the user's home directory via `--import`:

```json
"--import=data:text/javascript,import { homedir } from 'node:os'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; await import(pathToFileURL(join(homedir(), '.gemini/config/plugins/offload-worker/sync-skills.cjs')));"
```

---

## Per-Turn Opt-Out (`/no-offload`)

Add `/no-offload`, `--no-offload`, or `[no-offload]` as a standalone token in your prompt to run that turn directly in Antigravity. The tokens are case-insensitive. The bundled `/no-offload` skill skips `offload_task`, `generate_image`, and `list_offload_models` for that turn. Normal offloading resumes on subsequent turns without an opt-out token.

The `PreToolUse` hook in `hooks.json` runs `offload-turn-guard.cjs` to block those tool calls. Both `hooks.json` and `offload-turn-guard.cjs` belong at the plugin root `~/.gemini/config/plugins/offload-worker/`.

---

## MCP Tools

### `offload_task`

Delegates coding, testing, refactoring, debugging, reviews, or analysis to the active provider (with automatic fallback when `allow_fallback` is not `false`).

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` | `string` *(required)* | Task instruction for the worker model. |
| `provider` | `"codex" \| "opencode-go" \| "opencode" \| "deepseek"` | Explicit provider override. |
| `allow_fallback` | `boolean` | Fall back across configured providers on errors (default: `true`). |
| `model` | `string` | Explicit model ID (for Codex, omit to use Pareto auto-selection). |
| `task_tier` | `"auto" \| "quick" \| "standard" \| "deep" \| "frontier"` | Codex Pareto routing tier (default: `"auto"`). |
| `codex_sandbox` | `"read-only" \| "workspace-write" \| "danger-full-access"` | Codex sandbox mode (default: `"read-only"`). |
| `codex_reasoning_effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"` | Explicit Codex reasoning effort override. |
| `file_paths` | `string[]` | Workspace-contained file paths to embed inline up to `CODEX_MAX_EMBED_BYTES` (default 96 KiB, falling back to focus paths above the cap on Codex) or up to 512 KiB on HTTP providers. |
| `allowed_files` | `string[]` | Workspace-relative file paths the Codex worker is permitted to create or modify in `workspace-write` mode (defaults to `file_paths` when omitted). |
| `git_diff_base` | `string` | Git base ref (e.g. `"origin/main"`) to run `git diff <base>...HEAD` locally and attach hunk-scoped diff context for PR descriptions or diff reviews. |
| `workspace_dir` | `string` | Base workspace directory for `file_paths`, `input_images`, and `output_file`. Defaults to `cwd`. |
| `output_file` | `string` | Workspace-relative path to write the response text (do **not** combine with `workspace-write` or `danger-full-access` on Codex). |
| `input_images` | `string[]` | Workspace image paths to attach (`codex` provider only). |
| `thread_id` | `string` | Codex thread ID to resume an existing conversation. |
| `session_id` | `string` | Stable OpenCode session ID (`ses_...`) for cache routing. |
| `system_prompt` | `string` | Optional system instruction override. |
| `temperature` | `number` (`0`–`2`) | Sampling temperature for HTTP providers. |
| `max_tokens` | `integer` | Output token cap for HTTP providers. |
| `include_reasoning` | `boolean` | Include `<reasoning>` output when returned. |

### `list_offload_models`

Reports provider configuration/auth status and lists available models for the selected (or default) provider, supporting case-insensitive substring `filter`. For `codex`, it reads `$CODEX_HOME/models_cache.json` and annotates visible models with Pareto badges, default effort, and supported reasoning levels.

### `generate_image`

Generates or edits PNG images via Codex's built-in `$imagegen` (`gpt-image-2`) capability.

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` | `string` *(required)* | Image generation or editing prompt (`$imagegen` is prefixed automatically if absent). |
| `output_file` | `string` | Workspace-relative target path (e.g., `"assets/hero.png"`). Additional generated images receive `-2`, `-3` suffixes. |
| `workspace_dir` | `string` | Base directory for `output_file` and `input_images`. |
| `input_images` | `string[]` | Workspace reference images for editing or style guidance. |
| `thread_id` | `string` | Previous `generate_image` thread ID for iterative refinement. |
| `model` | `string` | Optional Codex model override. |

---

## Automatic Codex Model & Reasoning-Effort Selection

When `provider` resolves to `codex` and `model` / `codex_reasoning_effort` are omitted, `offload_task` inspects `$CODEX_HOME/models_cache.json` (default `~/.codex/models_cache.json`), filters to entries with `visibility === "list"`, sorts by `priority` ascending, and picks the lowest-priority non-legacy model (`upgrade == null`, non-legacy description) in each Pareto family:

| `task_tier` | Preferred Codex Family | Reasoning Effort | Typical Use Cases |
| --- | --- | --- | --- |
| `auto` *(default)* | Inferred from prompt, `file_paths` count, and sandbox | Per inferred tier | Automatic routing when you do not specify a tier. |
| `quick` | `*-luna` (`read-only`), `*-sol` (writes enabled) | `medium` on Luna, `low` on Sol | Short summaries, PR/commit descriptions, docstrings, simple read-only tasks. |
| `standard` | `*-sol` | `medium` | Everyday coding, localized edits, well-scoped `workspace-write` execution, unit tests. |
| `deep` | `*-sol` | `high` | Multi-file refactors (`>= 3` read-only or `>= 6` write files), debugging, code reviews, audits. |
| `frontier` | `*-astra` | `high` | Read-only architecture, concurrency/race debugging, security threat modeling, or explicit `task_tier: "frontier"`. |
| `input_images` set | `*-terra` | `medium` (`high` for `deep`/`frontier`) | UI screenshots, visual debugging, computer-use inspection. |

### Routing Rules & Precedence

1. **Override Precedence:** Explicit tool arguments (`model`, `codex_reasoning_effort`) > environment overrides (`CODEX_MODEL`, `CODEX_REASONING_EFFORT`) > Pareto router (`task_tier` or `"auto"` heuristic) > Codex SDK default (`chatgpt-subscription-default`).
2. **Effort Clamping:** Auto-selected reasoning efforts are clamped to the chosen model's `supported_reasoning_levels` (nearest lower supported effort, then `default_reasoning_level`). Explicit `xhigh`, `max`, and `ultra` values pass directly when requested.
3. **Graceful Fallbacks:** Missing families fall back to `*-sol`, then the first visible cached model. If `models_cache.json` is missing or unreadable, omitted fields fall back to the Codex SDK default.
4. **Prompt Cache Preservation:** Resuming a `thread_id` without explicit `model`, `codex_reasoning_effort`, or non-`auto` `task_tier` preserves the thread's existing model and effort.

---

## Provider Resolution & Environment Variables

When `provider` is omitted, the server resolves the active provider in this order:
`DEFAULT_OFFLOAD_PROVIDER` -> `OPENCODE_GO_API_KEY` (or `OPENCODE_API_KEY` + `OPENCODE_USE_GO=1|true`) -> `OPENCODE_API_KEY` -> `DEEPSEEK_API_KEY` -> Codex auth (`CODEX_API_KEY` / `OPENAI_API_KEY` / `$CODEX_HOME/auth.json`) -> `opencode`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_OFFLOAD_PROVIDER` | Auto-detected | Force default provider: `codex`, `opencode-go`, `opencode`, or `deepseek`. |
| `OFFLOAD_FALLBACK_ORDER` | `codex,opencode-go,opencode,deepseek` | Comma-separated fallback chain across configured providers. |
| `CODEX_HOME` | `~/.codex` | Codex directory for `auth.json`, `models_cache.json`, `generated_images/`, and synced `skills/`. |
| `CODEX_MODEL` | Unset | Default Codex model slug when `model` argument is omitted. |
| `CODEX_REASONING_EFFORT` | Unset | Default Codex effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`) when omitted. |
| `CODEX_AUTO_SELECT` | Enabled | Set to `0` or `false` to disable Pareto auto-selection and use only overrides/SDK defaults. |
| `CODEX_WINDOWS_SANDBOX` | `unelevated` | Windows sandbox mode passed for `workspace-write` (`prefer_mxc: true`). |
| `CODEX_SOFT_TIMEOUT_SECONDS` | `510` | Internal soft-deadline (`AbortController`) for `thread.runStreamed()`; returns partial progress and `threadId` before MCP's 600s hard timeout. |
| `CODEX_MAX_EMBED_BYTES` | `98304` (`96 KiB`) | Max total bytes of `file_paths` embedded directly into Codex prompts before falling back to path-only focus hints. |
| `CODEX_PREPEND_PATH` | Unset | Directory prepended to `PATH` inside Codex child processes without wiping inherited environment variables. |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | Unset | Optional API key auth for Codex instead of ChatGPT subscription login. |
| `OPENCODE_GO_API_KEY` | Unset | API key for OpenCode Go subscription endpoint. |
| `OPENCODE_API_KEY` | Unset | API key for OpenCode Console (also reused by OpenCode Go). |
| `OPENCODE_USE_GO` | Unset | Set `1` or `true` to prefer `opencode-go` when using `OPENCODE_API_KEY`. |
| `OPENCODE_MODEL` | `deepseek-v4.1-flash` | Default model for `opencode`. |
| `OPENCODE_GO_MODEL` | `kimi-k3` | Default model for `opencode-go`. |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference` | Base URL override for OpenCode Console. |
| `OPENCODE_GO_BASE_URL` | `https://opencode.ai/inference/go` | Base URL override for OpenCode Go. |
| `DEEPSEEK_API_KEY` | Unset | API key for DeepSeek API. |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Default model for `deepseek`. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | Base URL override for DeepSeek API. |

---

## Recommended Global Rule (`~/.gemini/GEMINI.md`)

Add the following to `~/.gemini/GEMINI.md` (or your project `AGENTS.md`) so Antigravity delegates automatically and writes diff-backed PR descriptions:

```markdown
# Global Offloading Rule

When `offload-worker` tools (`offload_task`, `generate_image`) are available in `<mcp_servers>` — **unless the current user prompt contains `/no-offload`, `--no-offload`, or `[no-offload]`**:

0. **Per-turn opt-out:** If the current user prompt contains `/no-offload`, `--no-offload`, or `[no-offload]`, skip all `offload-worker` tools (`offload_task`, `generate_image`, `list_offload_models`) for that turn only and execute directly in Antigravity. Resume normal offloading on subsequent turns without an opt-out token.

1. **Discover architecture before delegating multi-file work:** For multi-file feature or migration tasks, first run a fast architectural discovery pass (listing latest migrations, canonical services, and shared store schemas) and pass those exact canonical table/symbol names in `prompt`, `file_paths`, and `allowed_files` when calling `offload_task` (`provider="codex"`, `codex_sandbox="workspace-write"` for edits/tests; `"read-only"` for reviews/audits). Do not pre-read large unrelated files in Antigravity.
2. **Image tasks:** Use `generate_image` with `output_file` for image creation or editing.
3. **Fallback on errors:** If `codex` hits quota, rate limits, auth errors, or fails before modifying the workspace, allow `offload_task` to fall back to `opencode-go`, `opencode`, or `deepseek` (or retry explicitly with one of those `provider` values). Once `codex` in write mode has modified files or hit a soft timeout (`partial=true`), resume with its `thread_id` instead of falling back to HTTP providers. If all offload providers fail or `offload_task` is disabled in the current session, execute directly.
4. **Skip offloading for trivial turns:** Answer simple questions, 1-line commands, or single small lookups directly without spawning an offload call.
5. **Verify after writes:** Run targeted tests (`npm.cmd` on Windows) or `git diff --stat` after `workspace-write` tasks before reporting completion.
6. **PR descriptions:** Before `gh pr create` (or `gh pr edit`), run a `read-only` `offload_task` with `git_diff_base="origin/main"` (or the target base branch; do **not** pass full `file_paths`) to generate a structured PR body in normal prose (no caveman compression) citing only files and symbols added (`+`) or modified in the diff hunks, with grouped `### Changes` and `### Verification`. Write the PR body to a scratch `.md` file and pass it via `gh pr create --body-file <path>` to avoid PowerShell newline/backtick mangling.
```

Rule 6 prevents weak PR descriptions caused by summarizing only `offload_task`'s short reply, PowerShell `--body "..."` newline/backtick mangling, or terse prose bleeding into PRs.

---

## Project Layout & Development

```text
src/
  index.ts         MCP server registration & tool schemas
  codex.ts         Codex SDK runner, auth status, and $imagegen integration
  codex-models.ts  models_cache.json discovery & Pareto model/effort router
  providers.ts     OpenCode / DeepSeek HTTP clients, provider resolution, fallback chain
  files.ts         Workspace-contained file reading/writing & 512 KiB attachment limit
skills/
  offload-worker/  Bundled Antigravity / Codex skill instructions
sync-skills.cjs    Startup skill junction/symlink synchronizer
test/
  server.test.ts   Unit & in-memory/stdio MCP integration tests
  sync-skills.test.cjs  Skill synchronization tests (uses local mcp_config.json)
```

Run build and test verification:

```bash
npm run build
npm test
```
