import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildReviewRetroPrompt,
  DEFAULT_REVIEW_RETRO_PROMPT,
} from "./review-learnings-runner";

import {
  createTempWorkspace,
  moduleUrl,
  prependBinToPath,
  runTsxScript,
  writeFakeAgentBinary,
  writeJson,
  writeTestConfig,
} from "./test-harness";
import type { ReviewSummary } from "./types";

const RETRO_RUNNER_MODULE_URL = moduleUrl("src/lib/review-learnings-runner.ts");
const REVIEW_STORE_MODULE_URL = moduleUrl("src/lib/review-store.ts");
const LEARNINGS_STORE_MODULE_URL = moduleUrl(
  "src/lib/review-learnings-store.ts"
);

function sampleReview(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    pr_url: "https://github.com/acme/widget/pull/7",
    pr_number: 7,
    repo_slug: "acme/widget",
    title: "Add widget cache",
    author: "octocat",
    head_sha: "merge-head",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    summary:
      "## Summary\nThe cache change is mostly sound.\n\n## Agent Status\nAgent status: needs_author_changes",
    summary_head_sha: "reviewed-head",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "final",
    review_state: "archived",
    agent_review_status: "needs_author_changes",
    final_at: "2026-05-01T00:20:00.000Z",
    final_state: "merged",
    retro_status: "pending",
    ...overrides,
  };
}

function setupRetroWorkspace(prefix: string) {
  const workspace = createTempWorkspace(prefix);
  writeTestConfig(workspace, { review_runtime: "claude" });
  writeFakeAgentBinary(workspace, "claude");
  return workspace;
}

function runRetroScript(
  workspace: string,
  review: ReviewSummary,
  learningsBefore: string,
  env: NodeJS.ProcessEnv
) {
  return runTsxScript(
    workspace,
    [
      `import { spawnReviewRetro } from ${JSON.stringify(RETRO_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
      `import { readReviewLearnings, writeReviewLearnings } from ${JSON.stringify(LEARNINGS_STORE_MODULE_URL)};`,
    ],
    `
      const review = ${JSON.stringify(review)};
      await upsertReviewSummary(review);
      await writeReviewLearnings(${JSON.stringify(learningsBefore)});
      const spawned = await spawnReviewRetro(review, ${JSON.stringify(learningsBefore)});
      await spawned.done;
      console.log(JSON.stringify({
        pid: spawned.pid,
        persisted: readReviewSummaryMap()[review.pr_url],
        learnings: readReviewLearnings(),
      }));
    `,
    env
  );
}

test("spawnReviewRetro writes rewritten learnings and stamps done", () => {
  const workspace = setupRetroWorkspace("review-retro-success-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  const review = sampleReview();
  const learningsBefore = "# Review learnings\n\n- Existing guidance.\n";
  const rewritten = "# Review learnings\n\n- Existing guidance.\n- Check cache invalidation paths when PRs add memoization.\n";
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "retro-session",
        result: rewritten,
        is_error: false,
        duration_ms: 123,
      }),
    },
  });

  const result = runRetroScript(workspace, review, learningsBefore, {
    ...prependBinToPath(workspace),
    FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    FAKE_AGENT_ARGS_FILE: argsFile,
  });

  assert.equal(result.learnings, rewritten);
  assert.equal(result.persisted.retro_status, "done");
  assert.match(result.persisted.retro_done_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.persisted.retro_run_pid, undefined);
  assert.equal(result.persisted.retro_error, undefined);

  const args = JSON.parse(readFileSync(argsFile, "utf-8"));
  const prompt = args.args[args.args.indexOf("-p") + 1];
  assert.match(prompt, /https:\/\/github\.com\/acme\/widget\/pull\/7/);
  assert.match(prompt, /Agent review status: needs_author_changes/);
  assert.match(prompt, /The cache change is mostly sound/);
  assert.match(prompt, /Existing guidance/);
});

test("review retro wording and context cover both review sources", () => {
  assert.match(DEFAULT_REVIEW_RETRO_PROMPT, /both inbound reviews and Cortex task-owned PRs/);
  assert.match(DEFAULT_REVIEW_RETRO_PROMPT, /Use the gh CLI/);
  assert.doesNotMatch(DEFAULT_REVIEW_RETRO_PROMPT, /future inbound PR reviews/);

  const taskPrompt = buildReviewRetroPrompt(
    sampleReview({
      source: "task",
      task_id: "task-7",
      task_title: "Add widget cache",
      task_description: "Reduce duplicate widget requests.",
      task_plan: "Cache successful responses by ID.",
    }),
    "# Review learnings\n"
  );
  assert.match(taskPrompt, /Review source: task-owned Cortex PR/);
  assert.match(taskPrompt, /Cortex task ID: task-7/);
  assert.match(taskPrompt, /Reduce duplicate widget requests/);
  assert.match(taskPrompt, /Cache successful responses by ID/);

  const inboundPrompt = buildReviewRetroPrompt(
    sampleReview({ source: "inbound" }),
    "# Review learnings\n"
  );
  assert.match(inboundPrompt, /Review source: inbound PR/);
  assert.doesNotMatch(inboundPrompt, /Cortex task ID/);
});

test("spawnReviewRetro leaves learnings untouched and stamps error on failure", () => {
  const workspace = setupRetroWorkspace("review-retro-failure-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const review = sampleReview();
  const learningsBefore = "# Review learnings\n\n- Keep this.\n";
  writeJson(scenarioFile, {
    claude: {
      stderr: "boom",
      exitCode: 7,
    },
  });

  const result = runRetroScript(workspace, review, learningsBefore, {
    ...prependBinToPath(workspace),
    FAKE_AGENT_SCENARIO_FILE: scenarioFile,
  });

  assert.equal(result.learnings, learningsBefore);
  assert.equal(result.persisted.retro_status, "error");
  assert.match(result.persisted.retro_error, /boom|claude exited/);
  assert.equal(result.persisted.retro_run_pid, undefined);
});

test("spawnReviewRetro persists a low-disk preflight failure", () => {
  const workspace = setupRetroWorkspace("review-retro-disk-preflight-");
  const review = sampleReview();
  const learningsBefore = "# Review learnings\n\n- Keep this.\n";
  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewRetro } from ${JSON.stringify(RETRO_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const review = ${JSON.stringify(review)};
      await upsertReviewSummary(review);
      let thrown;
      try {
        await spawnReviewRetro(review, ${JSON.stringify(learningsBefore)});
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({
        thrown,
        persisted: readReviewSummaryMap()[review.pr_url],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      CORTEX_REVIEW_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER),
    }
  );

  assert.match(result.thrown, /Low disk space before launching claude review runtime/);
  assert.equal(result.persisted.retro_status, "error");
  assert.equal(result.persisted.retro_error, result.thrown);
  assert.equal(result.persisted.retro_run_pid, undefined);
});

test("spawnReviewRetro does not overwrite learnings changed during the run", () => {
  const workspace = setupRetroWorkspace("review-retro-manual-edit-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const review = sampleReview();
  const learningsBefore = "# Review learnings\n\n- Original.\n";
  const manualEdit = "# Review learnings\n\n- Manual edit.\n";
  const rewritten = "# Review learnings\n\n- Retro rewrite.\n";
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        result: rewritten,
        is_error: false,
      }),
      // The fsync-backed review-state claim can take longer under the
      // full parallel CI suite. Keep the fake retro alive until the manual
      // edit is deterministically written after spawnReviewRetro returns.
      sleepMs: 2_000,
    },
  });

  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewRetro } from ${JSON.stringify(RETRO_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
      `import { readReviewLearnings, writeReviewLearnings } from ${JSON.stringify(LEARNINGS_STORE_MODULE_URL)};`,
    ],
    `
      const review = ${JSON.stringify(review)};
      await upsertReviewSummary(review);
      await writeReviewLearnings(${JSON.stringify(learningsBefore)});
      const spawned = await spawnReviewRetro(review, ${JSON.stringify(learningsBefore)});
      await writeReviewLearnings(${JSON.stringify(manualEdit)});
      await spawned.done;
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[review.pr_url],
        learnings: readReviewLearnings(),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.learnings, manualEdit);
  assert.equal(result.persisted.retro_status, "error");
  assert.match(result.persisted.retro_error, /changed during retro/);
  assert.equal(result.persisted.retro_run_pid, undefined);
});

test("spawnReviewRetro treats empty output as an error", () => {
  const workspace = setupRetroWorkspace("review-retro-empty-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const review = sampleReview();
  const learningsBefore = "# Review learnings\n\n- Keep this.\n";
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        result: "   ",
        is_error: false,
      }),
    },
  });

  const result = runRetroScript(workspace, review, learningsBefore, {
    ...prependBinToPath(workspace),
    FAKE_AGENT_SCENARIO_FILE: scenarioFile,
  });

  assert.equal(result.learnings, learningsBefore);
  assert.equal(result.persisted.retro_status, "error");
  assert.match(result.persisted.retro_error, /empty learnings file/);
  assert.equal(result.persisted.retro_run_pid, undefined);
});
