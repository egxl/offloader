# Antigravity Offload MCP

Local `stdio` MCP server in TypeScript that lets Antigravity offload heavy code generation, debugging, refactoring, and file/log analysis to **OpenCode Console** (updated from Zen), **DeepSeek API**, and **OpenAI Codex CLI** (ChatGPT Plus/Pro/Go/Business subscription).

## Updated Endpoints & Providers (2026)

OpenCode Zen was renamed and integrated into **OpenCode Console**:

- **OpenCode Console (Pay-as-you-go)**: `https://opencode.ai/inference/openai/v1/chat/completions` (`models`: `https://opencode.ai/inference/v1/models`)
- **OpenCode Go (Subscription)**: `https://opencode.ai/inference/go/openai/v1/chat/completions` (`models`: `https://opencode.ai/inference/go/v1/models`)
- **DeepSeek API**: `https://api.deepseek.com/v1/chat/completions` (`models`: `https://api.deepseek.com/v1/models`)
- **OpenAI Codex (`provider: "codex"`)**: Uses `@openai/codex-sdk` + your local ChatGPT subscription login (`npm run codex-login`).

Notes from OpenCode Console docs:
- Free-tier chat models (such as `*-free` and `big-pickle`) return HTTP `403` from external clients; use paid Console credits or an OpenCode Go plan.
- Requests automatically include `User-Agent: antigravity-offload-mcp/1.0.0` and a stable `x-opencode-session` header for OpenCode cache routing.
- To use DeepSeek models through OpenCode Go/Console, enable **Global** under **Settings > Privacy > Regions** in the OpenCode Console.

## Setup

```bash
npm install
npm run build
# Optional: sign in with your ChatGPT/OpenAI subscription for provider="codex"
npm run codex-login
```

## Register in Antigravity

Add this entry inside `mcpServers` in `~/.gemini/config/mcp_config.json`. Replace the example path with the absolute path to your local build.

```json
{
  "mcpServers": {
    "offload-worker": {
      "command": "node",
      "args": [
        "C:/path/to/offloading/dist/src/index.js"
      ],
      "env": {
        "OPENCODE_API_KEY": "oc_sk_your_key_here",
        "DEEPSEEK_API_KEY": "sk-your_deepseek_key_here"
      },
      "timeoutSeconds": 600,
      "tools": {
        "offload_task": {
          "eager": true
        },
        "list_offload_models": {
          "eager": true
        }
      }
    }
  }
}
```

Optional environment variables:
- `DEFAULT_OFFLOAD_PROVIDER`: `opencode`, `opencode-go`, or `deepseek`
- `OPENCODE_USE_GO`: `"true"` to default OpenCode requests to `opencode-go`
- `OPENCODE_MODEL` / `OPENCODE_GO_MODEL` / `DEEPSEEK_MODEL`: override default model IDs
