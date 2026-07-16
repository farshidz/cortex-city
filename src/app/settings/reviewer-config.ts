import type { AgentRuntime, OrchestratorConfig } from "@/lib/types";

type ClearableConfigKey =
  | "default_claude_model"
  | "default_claude_effort"
  | "default_codex_model"
  | "default_codex_effort"
  | "review_prompt"
  | "reviewer_agent_prompt"
  | "review_effort"
  | "review_model";

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
  return {
    ...config,
    review_runtime: runtime,
    review_effort: undefined,
    review_model: undefined,
  };
}

export function buildConfigUpdate(
  config: OrchestratorConfig
): ConfigUpdatePayload {
  return {
    ...config,
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
