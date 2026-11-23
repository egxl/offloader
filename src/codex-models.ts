import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type { ModelSummary } from "./providers.js";

export const CODEX_REASONING_EFFORTS = [
  "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const satisfies readonly ModelReasoningEffort[];

export const CODEX_TASK_TIERS = ["auto", "quick", "standard", "deep", "frontier"] as const;
export type CodexTaskTier = (typeof CODEX_TASK_TIERS)[number];

export interface CodexCachedModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  input_modalities?: string[];
  upgrade?: unknown;
}

export interface CodexSelectionInput {
  prompt: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  taskTier?: CodexTaskTier;
  sandboxMode?: SandboxMode;
  fileCount?: number;
  hasInputImages?: boolean;
  isResume?: boolean;
}

export interface CodexSelectionResult {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  tier?: Exclude<CodexTaskTier, "auto">;
  source: "explicit" | "env" | "tier" | "auto" | "default";
  reason: string;
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function extractCodexSkillMentions(prompt: string): string[] {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/(?<![\w$])\$([a-z][a-z0-9-]*)/g)) {
    const name = match[1];
    if (name === "env" && prompt[match.index + match[0].length] === ":") {
      continue;
    }
    names.add(name);
  }
  return [...names];
}

export function findMissingCodexSkills(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const skillsDir = path.join(getCodexHome(env), "skills");
  return extractCodexSkillMentions(prompt).filter(
    (name) =>
      !fs.existsSync(path.join(skillsDir, name, "SKILL.md")) &&
      !fs.existsSync(path.join(skillsDir, ".system", name, "SKILL.md"))
  );
}

export function readCodexModelsCache(env: NodeJS.ProcessEnv = process.env): CodexCachedModel[] | null {
  try {
    const cache: { models?: CodexCachedModel[] } | null = JSON.parse(
      fs.readFileSync(path.join(getCodexHome(env), "models_cache.json"), "utf8")
    );
    if (!Array.isArray(cache?.models)) {
      return null;
    }
    return cache.models
      .filter((m) => typeof m?.slug === "string" && m.visibility === "list")
      .sort((a, b) =>
        (typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER) -
        (typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER)
      );
  } catch {
    return null;
  }
}

function isLegacyModel(model: CodexCachedModel): boolean {
  const description = typeof model.description === "string" ? model.description.trim() : "";
  return model.upgrade != null || /^(legacy|previous generation)\b/i.test(description);
}

export function pickFamilyWinner(
  models: readonly CodexCachedModel[],
  familySuffix: string
): CodexCachedModel | undefined {
  const suffix = "-" + familySuffix.toLowerCase();
  const family = models.filter((m) => m.slug.toLowerCase().endsWith(suffix));
  return family.find((m) => !isLegacyModel(m)) ?? family[0];
}

function getSupportedEfforts(model?: CodexCachedModel): string[] {
  const levels = model?.supported_reasoning_levels;
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels.filter((level) => typeof level?.effort === "string").map((level) => level.effort);
}

export function clampReasoningEffort(
  effort: ModelReasoningEffort,
  model?: CodexCachedModel
): ModelReasoningEffort {
  const supported = getSupportedEfforts(model);
  if (!supported.length || supported.includes(effort)) {
    return effort;
  }

  const requestedIndex = CODEX_REASONING_EFFORTS.findIndex((level) => level === effort);
  const lowerEffort = CODEX_REASONING_EFFORTS
    .slice(0, Math.max(requestedIndex, 0))
    .reverse()
    .find((level) => supported.includes(level));
  return lowerEffort
    ?? CODEX_REASONING_EFFORTS.find((level) => level === model?.default_reasoning_level && supported.includes(level))
    ?? CODEX_REASONING_EFFORTS.find((level) => supported.includes(level))
    ?? effort;
}

export function inferCodexTaskTier(
  input: Pick<CodexSelectionInput, "prompt" | "sandboxMode" | "fileCount">
): Exclude<CodexTaskTier, "auto"> {
  const { prompt, sandboxMode, fileCount = 0 } = input;
  const allowsWrites = sandboxMode === "workspace-write" || sandboxMode === "danger-full-access";
  if (!allowsWrites &&
      /\b(architect(ure)?|system design|concurrenc|race condition|deadlock|threat model|security audit|distributed|cross-cutting|multi-service|frontier)\b/i.test(prompt)) {
    return "frontier";
  }
  if (fileCount >= 6 ||
      (!allowsWrites && fileCount >= 3) ||
      /\b(refactor|debug|root[- ]cause|review|audit|optimi[sz]e|test suite|investigate|diagnos[ei])\b/i.test(prompt)) {
    return "deep";
  }
  if (!allowsWrites &&
      fileCount <= 1 && prompt.trim().length <= 320 &&
      /\b(pr description|pull request description|commit message|summari[sz]e|summary|format|typo|docstring|rename|explain briefly|changelog)\b/i.test(prompt)) {
    return "quick";
  }
  return "standard";
}

export function selectCodexModelAndEffort(
  input: CodexSelectionInput,
  env: NodeJS.ProcessEnv = process.env
): CodexSelectionResult {
  const explicitModel = input.model?.trim() || undefined;
  const explicitEffort = input.reasoningEffort;
  const envModel = env.CODEX_MODEL?.trim() || undefined;
  const envEffort = CODEX_REASONING_EFFORTS.find((level) => level === env.CODEX_REASONING_EFFORT?.trim());
  const model = explicitModel ?? envModel;
  const effort = explicitEffort ?? envEffort;
  const source = explicitModel || explicitEffort ? "explicit" : envModel || envEffort ? "env" : "default";
  const requestedTier = input.taskTier === "auto" ? undefined : input.taskTier;

  if (model && effort) {
    return { model, reasoningEffort: effort, source, reason: "Using model and reasoning effort overrides." };
  }
  if (input.isResume && !model && !effort && !requestedTier) {
    return {
      model: undefined,
      reasoningEffort: undefined,
      source: "default",
      reason: "Resuming thread without explicit model or tier override; preserving thread defaults.",
    };
  }
  if (env.CODEX_AUTO_SELECT === "0" || env.CODEX_AUTO_SELECT?.toLowerCase() === "false") {
    return { model, reasoningEffort: effort, source, reason: "CODEX_AUTO_SELECT disabled." };
  }
  const models = readCodexModelsCache(env);
  if (!models?.length) {
    return {
      model,
      reasoningEffort: effort,
      source,
      reason: "Codex models cache unavailable; using SDK default.",
    };
  }

  const tier = requestedTier ?? inferCodexTaskTier(input);
  const sol = pickFamilyWinner(models, "sol");
  let picked = sol ?? models[0];
  let targetEffort: ModelReasoningEffort = "medium";

  if (input.hasInputImages && !model) {
    picked = pickFamilyWinner(models, "terra") ?? picked;
    if (tier === "deep" || tier === "frontier") {
      targetEffort = "high";
    }
  } else if (tier === "quick") {
    const allowsWrites = input.sandboxMode === "workspace-write" || input.sandboxMode === "danger-full-access";
    const luna = allowsWrites ? undefined : pickFamilyWinner(models, "luna");
    picked = luna ?? picked;
    targetEffort = luna ? "medium" : "low";
  } else if (tier === "deep" || tier === "frontier") {
    targetEffort = "high";
    if (tier === "frontier") {
      picked = pickFamilyWinner(models, "astra") ?? picked;
    }
  }

  const modelForEffort = model ? models.find((m) => m.slug === model) : picked;
  return {
    model: model ?? picked.slug,
    reasoningEffort: effort ?? clampReasoningEffort(targetEffort, modelForEffort),
    tier,
    source: source === "default" ? (requestedTier ? "tier" : "auto") : source,
    reason: "Applied Pareto routing for the " + tier + " tier.",
  };
}

export function getCodexModelSummaries(
  env: NodeJS.ProcessEnv = process.env,
  filter?: string
): ModelSummary[] {
  const summaries: ModelSummary[] = [{
    id: "chatgpt-subscription-default",
    name: "Default model for your ChatGPT plan (omit 'model' parameter)",
  }];
  const models = readCodexModelsCache(env);
  if (models?.length) {
    const badges = new Map([
      [pickFamilyWinner(models, "luna"), "Pareto: quick"],
      [pickFamilyWinner(models, "terra"), "Pareto: vision"],
      [pickFamilyWinner(models, "sol"), "Pareto: standard/deep"],
      [pickFamilyWinner(models, "astra"), "Pareto: frontier"],
    ]);
    for (const model of models) {
      const badge = badges.get(model) ?? (isLegacyModel(model) ? "legacy" : undefined);
      const supported = getSupportedEfforts(model);
      const parts = [];
      if (badge) {
        parts.push(badge);
      }
      if (typeof model.default_reasoning_level === "string" && model.default_reasoning_level) {
        parts.push("default: " + model.default_reasoning_level);
      }
      if (supported.length) {
        parts.push("supported: " + supported.join(", "));
      }
      const displayName = (typeof model.display_name === "string" && model.display_name) || model.slug;
      summaries.push({
        id: model.slug,
        name: parts.length ? displayName + " [" + parts.join("; ") + "]" : displayName,
      });
    }
  } else {
    summaries.push(
      { id: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
      { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" }
    );
  }

  const needle = filter?.trim().toLowerCase();
  return needle ? summaries.filter((m) =>
    m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle)
  ) : summaries;
}
