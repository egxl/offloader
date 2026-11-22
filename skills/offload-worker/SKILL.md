---
name: offload-worker
description: >-
  Offload heavy code generation, unit tests, refactoring, debugging, or log and file
  analysis to OpenAI Codex (ChatGPT subscription), OpenCode Console/Go, or DeepSeek
  via the bundled offload-worker MCP tools to conserve Antigravity token quota.
  Use when the user asks to offload work, save Antigravity tokens/quota, or run a
  task with Codex, OpenCode, or DeepSeek.
---

# Offload Worker

Delegate token-heavy coding and analysis to external backends through the bundled
`offload-worker` MCP server (`offload_task`, `generate_image`, `list_offload_models`)
while keeping Antigravity as a minimal orchestrator.

## Strict Orchestration Rules

1. **Discover architecture before multi-file feature delegation:**
   - For multi-file features or schema/migration changes, run a fast architectural discovery
     pass first (list latest migrations, canonical services, and shared store schemas) and
     pass those exact canonical table/symbol names in `prompt`, `file_paths`, and
     `allowed_files` so the worker extends existing tables/services instead of inventing
     parallel ones.
   - For well-scoped single-file edits, reviews, or refactors where targets are already known,
     call `offload_task` immediately on step 1 without pre-reading large target files.
2. **Use `codex_sandbox: "workspace-write"` with explicit scope for edits & tests:**
   - Pass `allowed_files` (or accurate `file_paths`) to guard against out-of-scope edits.
   - Instruct the worker to edit files and run tests/build in `workspace_dir` and return
     only a concise summary.
   - Keep `codex_sandbox: "read-only"` (default) for reviews, audits, and Q&A.
   - Never use `codex_sandbox: "danger-full-access"` unless explicitly asked.
3. **Never combine `output_file` with `workspace-write`:**
   - Use `output_file` only with HTTP providers (`opencode`, `opencode-go`, `deepseek`)
     or `codex` in `read-only` mode.
4. **Prevent edit collisions:** Wait for `offload_task` to finish before touching the
   same files in Antigravity. If a partial soft-timeout returns (`partial=true`), resume
   with the returned `thread_id`.
5. **Reuse threads & batch tasks:** Bundle related subtasks into one `offload_task` call
   and pass `thread_id` (Codex) or `session_id` (OpenCode) for follow-ups.
6. **Verify minimally:** Run `git diff --stat` or the project's test command if Codex did
   not already report passing test output. On Windows, use `npm.cmd` instead of `npm.ps1`.

## Per-Turn Opt-Out

When the user prompt contains `/no-offload`, `--no-offload`, or `[no-offload]`, skip
all `offload-worker` tools for that turn and execute directly in Antigravity.
The `PreToolUse` hook in `hooks.json` enforces this through `offload-turn-guard.cjs`.

## Pull Request Descriptions

When creating or updating a PR after offloaded work:

1. **Generate from `git_diff_base` (never full `file_paths`):** Run a `read-only`
   `offload_task` with `git_diff_base: "origin/main"` (or the target base branch),
   optionally using `output_file` to write directly to a scratch `.md` file. Do not pass
   full `file_paths`, and instruct the worker to cite only files and symbols added (`+`)
   or modified in the diff hunks.
2. **Normal prose & structure:** Use normal technical prose (never caveman-compressed),
   with grouped `### Changes` (exact file paths and symbol names) and
   `### Verification` (exact test/build results).
3. **Pass via `--body-file`:** Run `gh pr create --body-file <path>` instead of inline
   `--body "..."` so PowerShell does not mangle newlines or backticks.

## Provider Selection & Automatic Fallback

1. **Primary (`codex`):** Uses `@openai/codex-sdk` via ChatGPT subscription (`codex login`).
2. **Fallback (`opencode-go` → `opencode` → `deepseek`):**
   - `offload_task` automatically falls back across configured providers when `codex`
     fails before modifying the workspace (quota, rate limit, auth).
   - Automatic fallback to HTTP providers is blocked once `codex` in write mode modifies
     files or runs commands, preventing split-brain state corruption.
   - Note: OpenCode `*-free` models return `403` outside OpenCode CLI/Desktop; use paid
     Console or Go models.
   - If `offload_task` reports all providers failed (or is unavailable in the current chat),
     fall back to direct execution in Antigravity.

If unsure which providers are authenticated or which model IDs exist, call
`list_offload_models`.

## Automatic Codex Model Selection

Omit `model` and `codex_reasoning_effort` to let Codex route tasks through
`$CODEX_HOME/models_cache.json` (defaults to `~/.codex/models_cache.json`).
`task_tier: "auto"` infers a tier from the prompt, file count, and sandbox. Set
`task_tier` explicitly to choose a rung of the Pareto ladder.

- `quick` uses Luna at `medium` for read-only tasks, or Sol at `low` for writes.
- `standard` uses Sol at `medium` (default for well-scoped write execution).
- `deep` uses Sol at `high` (6+ files, refactors, debugging, or audits).
- `frontier` uses Astra at `high` (reserved for read-only architecture/concurrency/security
  analysis or explicit `task_tier: "frontier"`).

Image inputs prefer Terra at `medium`, or `high` for `deep` and `frontier`.
Missing families fall back to Sol and then the first visible cached model.
Auto-selected effort is adjusted to the model's supported levels. An unavailable
cache leaves omitted settings to the SDK. A resumed `thread_id` with no overrides
preserves the thread's defaults.

`codex_reasoning_effort` accepts `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. Tool arguments take precedence over `CODEX_MODEL` and
`CODEX_REASONING_EFFORT`. Set `CODEX_AUTO_SELECT=0` or `false` to disable the
ladder. Call `list_offload_models` to see the cache's Pareto roles and reasoning
levels.

## Image Generation & Editing (`generate_image`)

1. Call `generate_image` with `prompt`, `workspace_dir`, and `output_file` (e.g.
   `"assets/hero.png"`). The server prefixes `$imagegen` automatically and copies the
   generated PNG from `$CODEX_HOME/generated_images/<thread_id>/` into `output_file`.
2. Pass workspace-relative paths in `input_images` for editing or style references.
3. Pass `thread_id` from the previous `generate_image` header to refine an existing image.
4. Note: Codex image generation uses `gpt-image-2` against your ChatGPT plan limits
   (roughly 3–5x faster quota burn than text turns).
