# Offload Worker

The plugin links Antigravity skills into Codex when its MCP server starts. It
scans `~/.gemini/config/skills` first, then each installed plugin's `skills`
directory in alphabetical order. Skill folders containing a `SKILL.md` are
linked into `~/.codex/skills` (or `$CODEX_HOME/skills` when set).
Existing entries take precedence, and `.system` is reserved.

Links are directory junctions on Windows and symlinks on macOS and Linux.
Install the plugin under `~/.gemini/config/plugins/offload-worker`, put Node.js
20.6 or newer on PATH, and set the final MCP argument in `mcp_config.json` to
the local offload-worker server build.

## Automatic Codex Model Selection

For Codex tasks, `offload_task` reads visible models and their supported reasoning
efforts from `$CODEX_HOME/models_cache.json`. If `CODEX_HOME` is unset, it uses
`~/.codex`. Each family uses the lowest-priority-number model among its current
entries, with legacy entries as a fallback. `list_offload_models` shows the cached
models, Pareto roles, and available efforts.

| `task_tier` | Preferred Codex model family | Reasoning effort |
| --- | --- | --- |
| `auto` (default) | Inferred from the prompt, file count, and sandbox | Per inferred tier |
| `quick` | Luna for read-only tasks, Sol for write-enabled tasks | `medium` on Luna, `low` on Sol |
| `standard` | Sol | `medium` |
| `deep` | Sol | `high` |
| `frontier` | Astra | `high` |

Image inputs prefer Terra at `medium`, or `high` for deep and frontier tasks.
Routing falls back to Sol and then the first visible model when the preferred
family is unavailable. Automatic effort is adjusted to the selected model's
supported levels. With no usable cache, Codex uses SDK defaults for any settings
you leave unspecified. Resuming via `thread_id` without overrides preserves the
thread's defaults.

Set `model` or `codex_reasoning_effort` to override automatic selection. Supported
effort values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
`CODEX_MODEL` and `CODEX_REASONING_EFFORT` supply overrides when the corresponding
tool argument is omitted. Set `CODEX_AUTO_SELECT=0` or `false` to disable the
Pareto ladder and use only overrides and SDK defaults.

## Recommended Global Rule (`~/.gemini/GEMINI.md`)

Add the following to `~/.gemini/GEMINI.md` (or your project `AGENTS.md`) so the
orchestrator delegates automatically and writes detailed, diff-backed PRs:

```markdown
# Global Offloading Rule

When `offload-worker` tools (`offload_task`, `generate_image`) are available in `<mcp_servers>`:

1. **Delegate heavy work first:** Before reading/editing multiple files or writing substantial code/tests/refactors inline, call `offload_task` (`provider="codex"`, `codex_sandbox="workspace-write"` for edits/tests; `"read-only"` for reviews/audits). Do not pre-read large target files in Antigravity first.
2. **Image tasks:** Use `generate_image` with `output_file` for image creation or editing.
3. **Fallback on errors:** If `codex` hits quota, rate limits, auth errors, or fails, allow `offload_task` to fall back to `opencode-go`, `opencode`, or `deepseek` (or retry explicitly with one of those `provider` values). If all offload providers fail or `offload_task` is disabled in the current session, execute directly.
4. **Skip offloading for trivial turns:** Answer simple questions, 1-line commands, or single small lookups directly without spawning an offload call.
5. **Verify after writes:** Run targeted tests or `git diff --stat` after `workspace-write` tasks before reporting completion.
6. **PR descriptions:** Before `gh pr create` (or `gh pr edit`), run a `read-only` `offload_task` against `git diff origin/main...HEAD` (or the target base branch) to generate a structured PR body in normal prose (no caveman compression) with grouped `### Changes` (exact file paths and symbol names) and `### Verification` (exact test/build output). Write the PR body to a scratch `.md` file and pass it via `gh pr create --body-file <path>` to avoid PowerShell newline/backtick mangling.
```

Rule 6 prevents weak PR descriptions caused by summarizing only `offload_task`'s short
reply, PowerShell `--body "..."` newline/backtick mangling, or terse/caveman prose
bleeding into PRs.
