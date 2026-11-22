---
name: no-offload
description: >-
  Disable `offload-worker` for the current prompt turn only and execute directly in Antigravity.
  Use when the user includes `/no-offload`, `--no-offload`, or `[no-offload]` in their prompt.
---

# No Offload

When the current user prompt includes `/no-offload`, `--no-offload`, or `[no-offload]`,
skip `offload_task`, `generate_image`, and `list_offload_models` for that turn. Execute
the task directly with Antigravity's native tools.

Resume normal offloading automatically on subsequent turns without an opt-out token.
