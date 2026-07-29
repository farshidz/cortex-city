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

test("buildReviewWrapperPrompt scopes stacked task reviews to their slice", () => {
  const config = {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions" as const,
    default_agent_runner: "claude" as const,
    agents: {},
  };
  const baseRequest = {
    source: "task" as const,
    task_id: "task-1",
    task_title: "Build the exporter",
    task_description: "Add CSV export",
    task_plan: undefined,
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
    repo_slug: "acme/widget",
    title: "Build the exporter (stack 2/3)",
    author: "",
    head_sha: "head-2",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };

  const stackedPrompt = runner.buildReviewWrapperPrompt(config, {
    ...baseRequest,
    task_stack_position: 2,
    task_stack_size: 3,
    task_pr_scope: "Wire the exporter into the reports page",
  });
  assert.match(stackedPrompt, /## Stacked PR slice/);
  assert.match(stackedPrompt, /slice 2 of 3/);
  assert.match(stackedPrompt, /Wire the exporter into the reports page/);
  assert.match(stackedPrompt, /Judge completeness and scope against this slice only/);

  const plainPrompt = runner.buildReviewWrapperPrompt(config, baseRequest);
  assert.doesNotMatch(plainPrompt, /Stacked PR slice/);
});
