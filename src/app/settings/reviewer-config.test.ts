import test from "node:test";
import assert from "node:assert/strict";

import type { OrchestratorConfig } from "@/lib/types";
import { applyReviewerRuntime, buildConfigUpdate } from "./reviewer-config";

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
