import type { OrchestratorConfig } from "./types";

export const DEFAULT_TASK_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function resolveTaskRunTimeoutMs(
  config: Pick<OrchestratorConfig, "task_run_timeout_ms">
): number {
  return typeof config.task_run_timeout_ms === "number"
    ? config.task_run_timeout_ms
    : DEFAULT_TASK_RUN_TIMEOUT_MS;
}
