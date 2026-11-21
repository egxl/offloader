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
