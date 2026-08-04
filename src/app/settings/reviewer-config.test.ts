import test from "node:test";
import assert from "node:assert/strict";

import type { OrchestratorConfig } from "@/lib/types";
import {
  applyReviewerRuntime,
  applyReviewerTier,
  buildConfigUpdate,
  reviewerTierConfig,
  reviewerTierRuntime,
} from "./reviewer-config";

function config(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "codex",
    agents: {},
    ...overrides,
  };
}

test("changing reviewer runtime clears runtime-specific model and effort overrides", () => {
  const updated = applyReviewerRuntime(
    config({
      review_runtime: "codex",
      review_model: "gpt-5.6",
      review_effort: "xhigh",
      review_prompt: "Keep this prompt",
    }),
    "claude"
  );

  assert.equal(updated.review_runtime, "claude");
  assert.equal(updated.review_model, undefined);
  assert.equal(updated.review_effort, undefined);
  assert.equal(updated.review_prompt, "Keep this prompt");
});

test("selecting the effective reviewer runtime preserves compatible overrides", () => {
  const updated = applyReviewerRuntime(
    config({ review_model: "gpt-5.6", review_effort: "xhigh" }),
    "codex"
  );

  assert.equal(updated.review_runtime, "codex");
  assert.equal(updated.review_model, "gpt-5.6");
  assert.equal(updated.review_effort, "xhigh");
});

test("config updates retain configured reviewer profile values", () => {
  const update = buildConfigUpdate(
    config({
      default_claude_model: "  claude-custom  ",
      default_claude_effort: "high",
      default_codex_model: "  gpt-custom  ",
      default_codex_effort: "xhigh",
      review_prompt: "  Keep this prompt formatting.  ",
      reviewer_agent_prompt: "  Check task context.  ",
      review_effort: "high",
      review_model: "  openrouter/custom-model  ",
    })
  );

  assert.equal(update.default_claude_model, "claude-custom");
  assert.equal(update.default_claude_effort, "high");
  assert.equal(update.default_codex_model, "gpt-custom");
  assert.equal(update.default_codex_effort, "xhigh");
  assert.equal(update.review_prompt, "  Keep this prompt formatting.  ");
  assert.equal(update.reviewer_agent_prompt, "  Check task context.  ");
  assert.equal(update.review_effort, "high");
  assert.equal(update.review_model, "openrouter/custom-model");
});

test("both reviewer tiers round-trip their runtime, model, and effort", () => {
  const edited = applyReviewerTier(
    applyReviewerTier(config({ review_runtime: "codex" }), 1, {
      runtime: "codex",
      model: "gpt-5.4",
      effort: "low",
    }),
    2,
    { model: "gpt-5.6-sol", effort: "high" }
  );

  assert.deepEqual(edited.reviewer_tiers, {
    tier1: { runtime: "codex", model: "gpt-5.4", effort: "low" },
    tier2: { model: "gpt-5.6-sol", effort: "high" },
  });
  assert.deepEqual(reviewerTierConfig(edited, 1), {
    runtime: "codex",
    model: "gpt-5.4",
    effort: "low",
  });
  // A tier with no runtime of its own follows the reviewer runtime.
  assert.equal(reviewerTierRuntime(edited, 2), "codex");

  const update = buildConfigUpdate(edited);
  assert.deepEqual(update.reviewer_tiers, edited.reviewer_tiers);
});

test("changing a tier's runtime clears its runtime-specific model and effort", () => {
  const switched = applyReviewerTier(
    config({
      review_runtime: "codex",
      reviewer_tiers: {
        tier1: { runtime: "codex", model: "gpt-5.4", effort: "low" },
      },
    }),
    1,
    { runtime: "claude" }
  );

  assert.deepEqual(switched.reviewer_tiers?.tier1, { runtime: "claude" });
});

test("a tier runtime can be cleared back to the reviewer default", () => {
  const pinned = applyReviewerTier(
    config({ review_runtime: "codex" }),
    1,
    { runtime: "claude", model: "claude-cheap", effort: "low" }
  );
  assert.deepEqual(pinned.reviewer_tiers?.tier1, { runtime: "claude" });

  // Clearing the pin is the switch that empties tier 1, which is how tiering is
  // turned off from Settings.
  const unpinned = applyReviewerTier(pinned, 1, { runtime: null });
  assert.deepEqual(unpinned.reviewer_tiers?.tier1, {});
  assert.equal(buildConfigUpdate(unpinned).reviewer_tiers, null);
  assert.equal(reviewerTierRuntime(unpinned, 1), "codex");

  // Clearing a pin that matched the inherited runtime keeps the tier's profile,
  // because its effective runtime did not change.
  const sameRuntime = applyReviewerTier(
    config({ review_runtime: "codex" }),
    1,
    { runtime: "codex", model: "gpt-5.4", effort: "low" }
  );
  assert.deepEqual(
    applyReviewerTier(sameRuntime, 1, { runtime: null }).reviewer_tiers?.tier1,
    { model: "gpt-5.4", effort: "low" }
  );
});

test("switching the parent runtime clears inherited tier profiles only", () => {
  const before = {
    ...config({ review_runtime: "codex" }),
    reviewer_tiers: {
      tier1: { model: "gpt-cheap", effort: "minimal" as const },
      tier2: { runtime: "codex" as const, model: "gpt-5.6-sol", effort: "ultra" as const },
    },
  };

  const switched = applyReviewerRuntime(before, "claude");

  // tier 1 inherits the reviewer runtime, so its Codex-only model and effort go.
  assert.deepEqual(switched.reviewer_tiers?.tier1, {});
  // tier 2 pins Codex, so it is untouched.
  assert.deepEqual(switched.reviewer_tiers?.tier2, {
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  });

  // Selecting the runtime a tier already resolves to changes nothing.
  assert.deepEqual(
    applyReviewerRuntime(before, "codex").reviewer_tiers,
    before.reviewer_tiers
  );
});

test("clearing every tier-1 field turns tiering off in the payload", () => {
  const cleared = buildConfigUpdate(
    config({
      reviewer_tiers: {
        tier1: { model: "   ", effort: undefined },
        tier2: { model: "  gpt-5.6-sol  " },
      },
    })
  );
  assert.deepEqual(cleared.reviewer_tiers, {
    tier2: { model: "gpt-5.6-sol" },
  });

  const allCleared = buildConfigUpdate(
    config({ reviewer_tiers: { tier1: {}, tier2: {} } })
  );
  assert.equal(allCleared.reviewer_tiers, null);
  assert.equal(buildConfigUpdate(config()).reviewer_tiers, null);
});

test("config updates explicitly clear optional reviewer profile values", () => {
  const update = buildConfigUpdate(
    config({
      default_claude_model: "",
      default_codex_model: "   ",
      review_prompt: "   ",
      reviewer_agent_prompt: "",
      review_model: "   ",
    })
  );

  assert.equal(update.default_claude_model, null);
  assert.equal(update.default_claude_effort, null);
  assert.equal(update.default_codex_model, null);
  assert.equal(update.default_codex_effort, null);
  assert.equal(update.review_prompt, null);
  assert.equal(update.reviewer_agent_prompt, null);
  assert.equal(update.review_effort, null);
  assert.equal(update.review_model, null);
});
