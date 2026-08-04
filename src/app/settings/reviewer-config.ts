import type {
  AgentRuntime,
  OrchestratorConfig,
  ReviewerTierConfig,
  ReviewerTiers,
  ReviewTier,
  TaskEffort,
} from "@/lib/types";

type ClearableConfigKey =
  | "default_claude_model"
  | "default_claude_effort"
  | "default_codex_model"
  | "default_codex_effort"
  | "review_prompt"
  | "reviewer_agent_prompt"
  | "review_effort"
  | "review_model"
  | "reviewer_tiers";

export type ConfigUpdatePayload = Omit<
  OrchestratorConfig,
  ClearableConfigKey
> & {
  [Key in ClearableConfigKey]-?: Exclude<
    OrchestratorConfig[Key],
    undefined
  > | null;
};

function configuredText(value?: string): string | null {
  return value?.trim() ? value : null;
}

function configuredModel(value?: string): string | null {
  return value?.trim() || null;
}

export function applyReviewerRuntime(
  config: OrchestratorConfig,
  runtime: AgentRuntime
): OrchestratorConfig {
  if ((config.review_runtime || config.default_agent_runner) === runtime) {
    return { ...config, review_runtime: runtime };
  }
  return clearInheritedTierProfiles(
    {
      ...config,
      review_runtime: runtime,
      review_effort: undefined,
      review_model: undefined,
    },
    config
  );
}

// A tier with no runtime of its own inherits the reviewer runtime, so its model
// and effort are runtime-specific values that a parent switch invalidates. A
// tier that pins its own runtime is unaffected.
export function clearInheritedTierProfiles(
  next: OrchestratorConfig,
  previous: OrchestratorConfig
): OrchestratorConfig {
  const tiers = next.reviewer_tiers;
  if (!tiers) return next;
  const cleared: ReviewerTiers = {};
  for (const tier of [1, 2] as const) {
    const key = tierKey(tier);
    const current = tiers[key];
    if (!current) continue;
    cleared[key] =
      !current.runtime &&
      reviewerTierRuntime(previous, tier) !== reviewerTierRuntime(next, tier)
        ? {}
        : current;
  }
  return { ...next, reviewer_tiers: cleared };
}

function tierKey(tier: ReviewTier): "tier1" | "tier2" {
  return tier === 1 ? "tier1" : "tier2";
}

export function reviewerTierConfig(
  config: OrchestratorConfig,
  tier: ReviewTier
): ReviewerTierConfig {
  return config.reviewer_tiers?.[tierKey(tier)] || {};
}

// The effective runtime for a tier: its own, else the single reviewer runtime,
// else the default agent runtime.
export function reviewerTierRuntime(
  config: OrchestratorConfig,
  tier: ReviewTier
): AgentRuntime {
  return (
    reviewerTierConfig(config, tier).runtime ||
    config.review_runtime ||
    config.default_agent_runner
  );
}

// `runtime: null` clears the tier's pin so it inherits the reviewer runtime.
// That is what makes tier 1 clearable, and therefore what makes tiering
// switchable off from Settings.
export interface ReviewerTierPatch {
  runtime?: AgentRuntime | null;
  model?: string;
  effort?: TaskEffort;
}

export function applyReviewerTier(
  config: OrchestratorConfig,
  tier: ReviewTier,
  patch: ReviewerTierPatch
): OrchestratorConfig {
  const key = tierKey(tier);
  const current = reviewerTierConfig(config, tier);
  const nextRuntime =
    patch.runtime === null
      ? undefined
      : patch.runtime === undefined
        ? current.runtime
        : patch.runtime;
  const merged: ReviewerTierConfig = {
    ...current,
    ...patch,
    runtime: nextRuntime,
  };
  // Model and effort are runtime-specific, so a change to the tier's effective
  // runtime drops both rather than carrying an incompatible pair. Clearing the
  // pin is a change only when the inherited runtime differs from the pin.
  const runtimeChanged =
    patch.runtime !== undefined &&
    reviewerTierRuntime({ ...config, reviewer_tiers: { [key]: merged } }, tier) !==
      reviewerTierRuntime(config, tier);
  const next: ReviewerTierConfig = {
    ...(merged.runtime ? { runtime: merged.runtime } : {}),
    ...(!runtimeChanged && merged.model?.trim() ? { model: merged.model } : {}),
    ...(!runtimeChanged && merged.effort ? { effort: merged.effort } : {}),
  };
  const tiers: ReviewerTiers = { ...config.reviewer_tiers, [key]: next };
  return { ...config, reviewer_tiers: tiers };
}

// Tier 1 is the rollout flag: clearing every field turns tiering off, so the
// payload must drop the block rather than persist an empty object.
function configuredTier(
  tier?: ReviewerTierConfig
): ReviewerTierConfig | undefined {
  if (!tier) return undefined;
  const next: ReviewerTierConfig = {
    ...(tier.runtime ? { runtime: tier.runtime } : {}),
    ...(tier.model?.trim() ? { model: tier.model.trim() } : {}),
    ...(tier.effort ? { effort: tier.effort } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

export function configuredReviewerTiers(
  tiers?: ReviewerTiers
): ReviewerTiers | null {
  const tier1 = configuredTier(tiers?.tier1);
  const tier2 = configuredTier(tiers?.tier2);
  if (!tier1 && !tier2) return null;
  return { ...(tier1 ? { tier1 } : {}), ...(tier2 ? { tier2 } : {}) };
}

export function buildConfigUpdate(
  config: OrchestratorConfig
): ConfigUpdatePayload {
  return {
    ...config,
    reviewer_tiers: configuredReviewerTiers(config.reviewer_tiers),
    default_claude_model: configuredModel(config.default_claude_model),
    default_claude_effort: config.default_claude_effort ?? null,
    default_codex_model: configuredModel(config.default_codex_model),
    default_codex_effort: config.default_codex_effort ?? null,
    review_prompt: configuredText(config.review_prompt),
    reviewer_agent_prompt: configuredText(config.reviewer_agent_prompt),
    review_effort: config.review_effort ?? null,
    review_model: configuredModel(config.review_model),
  };
}
