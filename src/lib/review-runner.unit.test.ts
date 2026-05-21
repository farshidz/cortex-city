// In-process tests that touch each review-runner export so c8 records every
// re-export wrapper as hit, complementing the subprocess-based tests in
// review-runner.test.ts.
import test from "node:test";
import assert from "node:assert/strict";

import * as runner from "./review-runner";

test("review-runner exports are reachable via module namespace", () => {
  assert.equal(typeof runner.summarizePR, "function");
  assert.equal(typeof runner.spawnReviewSummary, "function");
  assert.equal(typeof runner.askFollowup, "function");
  assert.equal(typeof runner.appendFollowup, "function");
  assert.equal(typeof runner.resolveReviewOpts, "function");
  assert.equal(typeof runner.resolveReviewPrompt, "function");
  assert.equal(typeof runner.resolveReviewRunTimeoutMs, "function");
  assert.equal(typeof runner.DEFAULT_REVIEW_PROMPT, "string");
  assert.ok(runner.DEFAULT_REVIEW_PROMPT.length > 0);
});

test("resolveReviewOpts and resolveReviewPrompt cover their fallback branches", () => {
  const baseConfig = {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    task_run_timeout_ms: undefined,
    default_permission_mode: "bypassPermissions" as const,
    default_agent_runner: "claude" as const,
    agents: {},
  };
  // No review_* set anywhere → falls back to runtime defaults.
  const claudeOpts = runner.resolveReviewOpts(baseConfig);
  assert.equal(claudeOpts.runtime, "claude");
  // Codex override pulls runtime from override.
  const codexOpts = runner.resolveReviewOpts(baseConfig, { runtime: "codex" });
  assert.equal(codexOpts.runtime, "codex");

  // Prompt: no configured prompt → default.
  assert.equal(runner.resolveReviewPrompt(baseConfig), runner.DEFAULT_REVIEW_PROMPT);
  // Blank/whitespace → default.
  assert.equal(
    runner.resolveReviewPrompt({ ...baseConfig, review_prompt: "   " }),
    runner.DEFAULT_REVIEW_PROMPT
  );
  // Trimmed configured prompt wins.
  assert.equal(
    runner.resolveReviewPrompt({ ...baseConfig, review_prompt: " hi " }),
    "hi"
  );

  // Review runs use the same timeout setting and fallback as task runs.
  assert.equal(runner.resolveReviewRunTimeoutMs(baseConfig), 2 * 60 * 60 * 1000);
  assert.equal(
    runner.resolveReviewRunTimeoutMs({
      ...baseConfig,
      task_run_timeout_ms: 1234,
    }),
    1234
  );
  assert.equal(
    runner.resolveReviewRunTimeoutMs({
      ...baseConfig,
      task_run_timeout_ms: 0,
    }),
    0
  );
});
