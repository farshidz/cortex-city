// The review debounce window, in its own module so the config API route can
// enforce the same bounds without importing the worker runtime.
import type { OrchestratorConfig } from "./types";

export const REVIEW_DEBOUNCE_DEFAULT_SECONDS = 300;
export const REVIEW_DEBOUNCE_MAX_SECONDS = 3600;

export function resolveReviewDebounceMs(
  config: Pick<OrchestratorConfig, "review_debounce_seconds">
): number {
  const configured = config.review_debounce_seconds;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return REVIEW_DEBOUNCE_DEFAULT_SECONDS * 1000;
  }
  // Clamped as well as validated at the write boundary, so a hand-edited
  // config.json cannot postpone reviews past the documented maximum.
  const seconds = Math.min(
    REVIEW_DEBOUNCE_MAX_SECONDS,
    Math.max(0, Math.round(configured))
  );
  return seconds * 1000;
}
