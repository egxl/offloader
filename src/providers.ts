import crypto from "node:crypto";
import { getCodexAuthStatus } from "./codex.js";
import { getCodexModelSummaries } from "./codex-models.js";

export type HttpProviderId = "opencode" | "opencode-go" | "deepseek";
export type ProviderId = HttpProviderId | "codex";

export interface ProviderConfig {
  id: HttpProviderId;
  label: string;
  chatUrl: string;
  modelsUrl: string;
  envKeys: string[];
  defaultModel: string;
  isOpenCode: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OffloadRequest {
  provider?: HttpProviderId;
  model?: string;
  messages: ChatMessage[];
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  includeReasoning?: boolean;
}

export interface OffloadResponse {
  provider: ProviderId;
  model: string;
  content: string;
  reasoning?: string;
  reasoningEffort?: string;
  selectionTier?: string;
  finishReason?: string;
  threadId?: string;
  changedFiles?: string[];
  commandsRun?: string[];
  partial?: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ModelSummary {
  id: string;
  name?: string;
  type?: string;
  owned_by?: string;
}

const DEFAULT_SESSION_ID = `ses_${crypto.randomUUID()}`;
const USER_AGENT = "antigravity-offload-mcp/1.0.0";

function joinEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

export function getProviderConfigs(
  env: NodeJS.ProcessEnv = process.env
): Record<HttpProviderId, ProviderConfig> {
  const openCodeBase = env.OPENCODE_BASE_URL || "https://opencode.ai/inference";
  const openCodeGoBase =
    env.OPENCODE_GO_BASE_URL || "https://opencode.ai/inference/go";
  const deepseekBase = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

  return {
    opencode: {
      id: "opencode",
      label: "OpenCode Console (Pay-as-you-go)",
      chatUrl: joinEndpoint(openCodeBase, "/openai/v1/chat/completions"),
      modelsUrl: joinEndpoint(openCodeBase, "/v1/models"),
      envKeys: ["OPENCODE_API_KEY"],
      defaultModel: env.OPENCODE_MODEL || "deepseek-v4.1-flash",
      isOpenCode: true,
    },
    "opencode-go": {
      id: "opencode-go",
      label: "OpenCode Go (Subscription)",
      chatUrl: joinEndpoint(openCodeGoBase, "/openai/v1/chat/completions"),
      modelsUrl: joinEndpoint(openCodeGoBase, "/v1/models"),
      envKeys: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
      defaultModel: env.OPENCODE_GO_MODEL || "kimi-k3",
      isOpenCode: true,
    },
    deepseek: {
      id: "deepseek",
      label: "DeepSeek API",
      chatUrl: joinEndpoint(deepseekBase, "/chat/completions"),
      modelsUrl: joinEndpoint(deepseekBase, "/models"),
      envKeys: ["DEEPSEEK_API_KEY"],
      defaultModel: env.DEEPSEEK_MODEL || "deepseek-chat",
      isOpenCode: false,
    },
  };
}

export function resolveApiKey(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  for (const keyName of config.envKeys) {
    const val = env[keyName]?.trim();
    if (val) {
      return val;
    }
  }
  return undefined;
}

export function getFallbackChain(
  primary: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
  allowFallback?: boolean
): ProviderId[] {
  if (allowFallback === false) return [primary];

  const chain = new Set<ProviderId>([primary]);
  const configs = getProviderConfigs(env);
  const order = env.OFFLOAD_FALLBACK_ORDER ?? "codex,opencode-go,opencode,deepseek";
  for (const entry of order.split(",")) {
    const id = entry.trim() as ProviderId;
    if (chain.has(id)) continue;
    const configured = id === "codex"
      ? getCodexAuthStatus(env).configured
      : Object.hasOwn(configs, id) && Boolean(resolveApiKey(configs[id], env));
    if (configured) chain.add(id);
  }
  return [...chain];
}

export function resolveProviderId(
  requested?: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): ProviderId {
  if (requested) {
    return requested;
  }

  const explicitDefault = env.DEFAULT_OFFLOAD_PROVIDER as ProviderId | undefined;
  if (
    explicitDefault === "opencode" ||
    explicitDefault === "opencode-go" ||
    explicitDefault === "deepseek" ||
    explicitDefault === "codex"
  ) {
    return explicitDefault;
  }

  const useGo = env.OPENCODE_USE_GO === "1" || env.OPENCODE_USE_GO === "true";
  if (env.OPENCODE_GO_API_KEY?.trim() || (useGo && env.OPENCODE_API_KEY?.trim())) {
    return "opencode-go";
  }
  if (env.OPENCODE_API_KEY?.trim()) {
    return "opencode";
  }
  if (env.DEEPSEEK_API_KEY?.trim()) {
    return "deepseek";
  }
  if (getCodexAuthStatus(env).configured) {
    return "codex";
  }

  return "opencode";
}

function buildHeaders(
  config: ProviderConfig,
  apiKey?: string,
  sessionId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (config.isOpenCode) {
    headers["x-opencode-session"] = sessionId || DEFAULT_SESSION_ID;
  }

  return headers;
}

function formatHttpError(
  config: ProviderConfig,
  status: number,
  bodyText: string
): Error {
  const snippet = bodyText.slice(0, 600).trim();
  const hints: string[] = [];

  if (config.isOpenCode && status === 403) {
    hints.push(
      "Note: OpenCode free-tier models (such as *-free or big-pickle) return 403 outside OpenCode CLI/Desktop. Use a paid Console model or an OpenCode Go subscription model. If using DeepSeek models on OpenCode, ensure Global regions are enabled in Workspace Settings > Privacy."
    );
  } else if (status === 401) {
    hints.push(`Verify ${config.envKeys.join(" or ")} is set and valid.`);
  }

  const hintText = hints.length > 0 ? ` ${hints.join(" ")}` : "";
  return new Error(
    `${config.label} HTTP ${status}: ${snippet || "Empty error response"}${hintText}`
  );
}

export async function callChatCompletion(
  req: OffloadRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<OffloadResponse> {
  const configs = getProviderConfigs(env);
  const providerId = resolveProviderId(req.provider, env);
  if (providerId === "codex") {
    throw new Error("Codex provider must be routed through callCodexCompletion.");
  }
  const config = configs[providerId];
  const apiKey = resolveApiKey(config, env);

  if (!apiKey) {
    throw new Error(
      `Missing API key for ${config.label}. Set ${config.envKeys.join(" or ")} in your MCP server env config.`
    );
  }

  const model = req.model?.trim() || config.defaultModel;
  const payload: Record<string, unknown> = {
    model,
    messages: req.messages,
    stream: false,
  };

  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    payload.max_tokens = req.maxTokens;
  }

  const res = await fetchFn(config.chatUrl, {
    method: "POST",
    headers: buildHeaders(config, apiKey, req.sessionId),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw formatHttpError(config, res.status, errText);
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? "";
  const reasoning = choice?.message?.reasoning_content ?? undefined;

  if (!content && !reasoning) {
    throw new Error(`${config.label} returned an empty response for model "${model}".`);
  }

  return {
    provider: providerId,
    model: data.model || model,
    content,
    reasoning: req.includeReasoning ? reasoning : undefined,
    finishReason: choice?.finish_reason,
    usage: data.usage,
  };
}

export async function fetchProviderModels(
  provider?: ProviderId,
  filter?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<{ provider: ProviderId; label: string; models: ModelSummary[] }> {
  const providerId = resolveProviderId(provider, env);
  if (providerId === "codex") {
    return {
      provider: "codex",
      label: "OpenAI Codex CLI (ChatGPT Subscription)",
      models: getCodexModelSummaries(env, filter),
    };
  }

  const configs = getProviderConfigs(env);
  const config = configs[providerId];
  const apiKey = resolveApiKey(config, env);

  if (!config.isOpenCode && !apiKey) {
    throw new Error(
      `Missing API key for ${config.label} to list models. Set ${config.envKeys.join(" or ")}.`
    );
  }

  const res = await fetchFn(config.modelsUrl, {
    method: "GET",
    headers: buildHeaders(config, apiKey),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw formatHttpError(config, res.status, errText);
  }

  const data = (await res.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      type?: string;
      owned_by?: string;
    }>;
  };

  let models: ModelSummary[] = (data.data || []).map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    owned_by: m.owned_by,
  }));

  if (filter?.trim()) {
    const needle = filter.trim().toLowerCase();
    models = models.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        (m.name && m.name.toLowerCase().includes(needle))
    );
  }

  return {
    provider: providerId,
    label: config.label,
    models,
  };
}
