import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  buildReviewWrapperPrompt,
  DEFAULT_REVIEW_PROMPT,
  isReviewSessionCompatible,
  parseReviewAgentStatus,
  resolveReviewOpts,
  resolveReviewPrompt,
} from "./review-runner";
import {
  createTempWorkspace,
  moduleUrl,
  prependBinToPath,
  runTsxScript,
  writeFakeAgentBinary,
  writeJson,
  writeTestConfig,
} from "./test-harness";
import type {
  OrchestratorConfig,
  ReviewRequest,
  ReviewSummary,
} from "./types";

const REVIEW_RUNNER_MODULE_URL = moduleUrl("src/lib/review-runner.ts");
const REVIEW_STORE_MODULE_URL = moduleUrl("src/lib/review-store.ts");

function baseConfig(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium",
    agents: {},
    ...overrides,
  };
}

function sampleRequest(
  overrides: Partial<ReviewRequest> = {}
): ReviewRequest {
  return {
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
    repo_slug: "acme/widget",
    title: "Add fizzbuzz",
    author: "octocat",
    head_sha: "abc123",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function setupRunnerWorkspace(
  prefix: string,
  configOverrides: Partial<OrchestratorConfig> = {}
): string {
  const workspace = createTempWorkspace(prefix);
  writeTestConfig(workspace, configOverrides, {
    "cortex-city-swe": {
      default_branch: "main",
    },
  });
  writeFakeAgentBinary(workspace, "claude");
  writeFakeAgentBinary(workspace, "codex");
  return workspace;
}

test("resolveReviewOpts prefers explicit overrides, then review_* config, then runtime defaults", () => {
  const config = baseConfig({
    review_runtime: "codex",
    review_effort: "high",
    review_model: "review-model",
  });
  const opts = resolveReviewOpts(config);
  assert.deepEqual(opts, {
    runtime: "codex",
    effort: "high",
    model: "review-model",
  });

  const overridden = resolveReviewOpts(config, {
    runtime: "claude",
    effort: "low",
    model: "  override  ",
  });
  assert.deepEqual(overridden, {
    runtime: "claude",
    effort: "low",
    model: "override",
  });
});

test("resolveReviewOpts falls back to runtime-specific defaults when review_* is unset", () => {
  const config = baseConfig({
    review_runtime: undefined,
    review_effort: undefined,
    review_model: undefined,
  });
  const claudeOpts = resolveReviewOpts(config);
  assert.deepEqual(claudeOpts, {
    runtime: "claude",
    effort: "high",
    model: "claude-sonnet-4-6",
  });

  const codexOpts = resolveReviewOpts(config, { runtime: "codex" });
  assert.deepEqual(codexOpts, {
    runtime: "codex",
    effort: "medium",
    model: "gpt-5.4",
  });
});

test("resolveReviewOpts does not leak the configured reviewer profile across runtimes", () => {
  const config = baseConfig({
    review_runtime: "codex",
    review_effort: "ultra",
    review_model: "gpt-5.6",
  });
  assert.deepEqual(resolveReviewOpts(config, { runtime: "claude" }), {
    runtime: "claude",
    effort: "high",
    model: "claude-sonnet-4-6",
  });
  assert.deepEqual(
    resolveReviewOpts(config, {
      runtime: "claude",
      effort: "low",
      model: "claude-custom",
    }),
    { runtime: "claude", effort: "low", model: "claude-custom" }
  );
});

test("resolveReviewPrompt prefers the configured prompt and falls back to the default", () => {
  assert.equal(resolveReviewPrompt(baseConfig()), DEFAULT_REVIEW_PROMPT);
  const custom = baseConfig({ review_prompt: "  my prompt  " });
  assert.equal(resolveReviewPrompt(custom), "my prompt");
  const blank = baseConfig({ review_prompt: "   " });
  assert.equal(resolveReviewPrompt(blank), DEFAULT_REVIEW_PROMPT);
});

test("buildReviewWrapperPrompt injects review learnings when enabled and non-empty", () => {
  const workspace = setupRunnerWorkspace("review-runner-learnings-");
  const request = sampleRequest();
  const result = runTsxScript(
    workspace,
    [
      `import { buildReviewWrapperPrompt } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const cortexDir = path.join(process.cwd(), ".cortex");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.writeFileSync(
        path.join(cortexDir, "review-learnings.md"),
        "- Check repo-tagged lessons only for matching repositories.\\n"
      );
      const prompt = buildReviewWrapperPrompt(
        ${JSON.stringify(baseConfig({ review_learning_enabled: true }))},
        ${JSON.stringify(request)}
      );
      console.log(JSON.stringify({ prompt }));
    `,
    prependBinToPath(workspace)
  );

  assert.match(result.prompt, /## Lessons from past reviews/);
  assert.match(result.prompt, /Check repo-tagged lessons/);
  assert.ok(
    result.prompt.indexOf("## Lessons from past reviews") <
      result.prompt.indexOf(`Review this PR: ${request.pr_url}`)
  );
});

test("buildReviewWrapperPrompt omits review learnings when disabled or empty", () => {
  const workspace = setupRunnerWorkspace("review-runner-learnings-disabled-");
  const request = sampleRequest();
  const result = runTsxScript(
    workspace,
    [
      `import { buildReviewWrapperPrompt } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const cortexDir = path.join(process.cwd(), ".cortex");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.writeFileSync(path.join(cortexDir, "review-learnings.md"), "- Keep this hidden.\\n");
      const disabled = buildReviewWrapperPrompt(
        ${JSON.stringify(baseConfig({ review_learning_enabled: false }))},
        ${JSON.stringify(request)}
      );
      fs.writeFileSync(path.join(cortexDir, "review-learnings.md"), "");
      const empty = buildReviewWrapperPrompt(
        ${JSON.stringify(baseConfig({ review_learning_enabled: true }))},
        ${JSON.stringify(request)}
      );
      console.log(JSON.stringify({ disabled, empty }));
    `,
    prependBinToPath(workspace)
  );

  assert.doesNotMatch(result.disabled, /## Lessons from past reviews/);
  assert.doesNotMatch(result.disabled, /Keep this hidden/);
  assert.doesNotMatch(result.empty, /## Lessons from past reviews/);
});

test("buildReviewWrapperPrompt applies source-specific policy and task context", () => {
  const config = baseConfig({
    review_learning_enabled: false,
    reviewer_agent_prompt: "Check the task's accessibility requirements.",
  });
  const taskPrompt = buildReviewWrapperPrompt(
    config,
    sampleRequest({
      source: "task",
      task_id: "task-42",
      task_title: "Improve keyboard navigation",
      task_description: "Make every dialog keyboard accessible.",
      task_plan: "Add focus trapping, then test escape handling.",
    })
  );
  assert.match(taskPrompt, /Review source: task-owned pull request/);
  assert.match(taskPrompt, /never approve it or request changes on GitHub/i);
  assert.match(taskPrompt, /specific, actionable GitHub comments/i);
  assert.match(
    taskPrompt,
    /Start every GitHub comment you post with `\*\*🤖\[Cortex City Reviewer\]\*\*`/
  );
  assert.match(taskPrompt, /Task ID: task-42/);
  assert.match(taskPrompt, /Improve keyboard navigation/);
  assert.match(taskPrompt, /Make every dialog keyboard accessible/);
  assert.match(taskPrompt, /Add focus trapping/);
  assert.match(taskPrompt, /Check the task's accessibility requirements/);
  assert.match(taskPrompt, /never authorizes self-approval/i);

  const inboundPrompt = buildReviewWrapperPrompt(config, sampleRequest());
  assert.match(inboundPrompt, /Review source: inbound pull request/);
  assert.match(inboundPrompt, /someone else's PR/);
  assert.doesNotMatch(inboundPrompt, /accessibility requirements/);
  assert.doesNotMatch(inboundPrompt, /Cortex task context/);

  const selfAuthoredPrompt = buildReviewWrapperPrompt(
    config,
    sampleRequest({ label_only: true, self_authored: true })
  );
  assert.match(
    selfAuthoredPrompt,
    /Review source: label-selected self-authored pull request/
  );
  assert.match(selfAuthoredPrompt, /`cortex-city-review` label/);
  assert.match(
    selfAuthoredPrompt,
    /never approve it or request changes on GitHub/i
  );
  assert.doesNotMatch(selfAuthoredPrompt, /someone else's PR/);
});

test("isReviewSessionCompatible requires the same source, runtime, model, and effort", () => {
  const request = sampleRequest({ source: "inbound" });
  const cached = {
    ...request,
    summary: "Reviewed",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
    session_id: "session-1",
    runtime: "codex",
    effort: "xhigh",
    model: "gpt-5.6",
    session_profile: {
      runtime: "codex",
      effort: "xhigh",
      model: "gpt-5.6",
    },
  } satisfies ReviewSummary;
  assert.equal(
    isReviewSessionCompatible(request, cached, {
      runtime: "codex",
      effort: "xhigh",
      model: "gpt-5.6",
    }),
    true
  );
  for (const incompatible of [
    { runtime: "claude", effort: "xhigh", model: "gpt-5.6" },
    { runtime: "codex", effort: "high", model: "gpt-5.6" },
    { runtime: "codex", effort: "xhigh", model: "gpt-5.5" },
  ] as const) {
    assert.equal(isReviewSessionCompatible(request, cached, incompatible), false);
  }
  assert.equal(
    isReviewSessionCompatible(
      { ...request, source: "task", task_id: "task-1" },
      cached,
      { runtime: "codex", effort: "xhigh", model: "gpt-5.6" }
    ),
    false
  );
});

test("parseReviewAgentStatus reads the exact agent status marker", () => {
  assert.equal(
    parseReviewAgentStatus("## Agent Status\nAgent status: `ready_for_human_approval`"),
    "ready_for_human_approval"
  );
  assert.equal(
    parseReviewAgentStatus("Agent readiness - needs author changes"),
    "needs_author_changes"
  );
  assert.equal(parseReviewAgentStatus("No marker here"), undefined);
});

test("summarizePR persists Claude output as a ReviewSummary", () => {
  const workspace = setupRunnerWorkspace("review-runner-claude-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-1",
        result: "## Summary\nLooks fine.",
        is_error: false,
        duration_ms: 1234,
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    },
  });

  const request = sampleRequest();
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.summary.summary, "## Summary\nLooks fine.");
  assert.equal(result.summary.session_id, "claude-session-1");
  assert.equal(result.summary.runtime, "claude");
  assert.equal(result.summary.input_tokens, 12);
  assert.equal(result.summary.output_tokens, 34);
  assert.equal(result.summary.error, undefined);
  assert.equal(result.summary.current_run_pid, undefined);
  assert.equal(result.summary.summary_head_sha, request.head_sha);
  assert.equal(result.persisted.summary, "## Summary\nLooks fine.");
  assert.equal(result.persisted.summary_head_sha, request.head_sha);
  assert.equal(result.persisted.session_id, "claude-session-1");
});

test("spawnReviewSummary preserves retro state during summary refreshes", () => {
  const workspace = setupRunnerWorkspace("review-runner-retro-preserve-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-retro",
        result: "## Summary\nUpdated.",
        is_error: false,
      }),
      sleepMs: 100,
    },
  });

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old summary",
          summary_head_sha: request.head_sha,
          generated_at: "2026-05-01T00:00:00.000Z",
          retro_status: "pending",
          retro_run_pid: 60_000,
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary, readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const spawned = await spawnReviewSummary(${JSON.stringify(request)}, { runtime: "claude" });
      const during = readReviewSummaryMap()[${JSON.stringify(request.pr_url)}];
      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        retro_status: "done",
        retro_done_at: "2026-05-01T00:20:00.000Z",
        retro_run_pid: undefined,
        retro_error: undefined,
      });
      const summary = await spawned.done;
      console.log(JSON.stringify({
        during,
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.during.retro_status, "pending");
  assert.equal(result.during.retro_run_pid, 60_000);
  assert.equal(result.summary.summary, "## Summary\nUpdated.");
  assert.equal(result.persisted.retro_status, "done");
  assert.equal(result.persisted.retro_done_at, "2026-05-01T00:20:00.000Z");
  assert.equal(result.persisted.retro_run_pid, undefined);
  assert.equal(result.persisted.retro_error, undefined);
});

test("spawnReviewSummary preserves review signals updated while the run is in flight", () => {
  const workspace = setupRunnerWorkspace("review-runner-approval-preserve-");
  const scenarioFile = path.join(workspace, "scenario.json");
  // Delay the run so the mid-flight approval patch lands before completion.
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-approval",
        result: "## Summary\nUpdated.",
        is_error: false,
      }),
      sleepMs: 100,
    },
  });

  // The spawn-time request has no approval (it was captured before the user
  // approved). An optimistic approval is recorded while the run is in flight.
  const request = sampleRequest({ my_approval_sha: undefined });
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old summary",
          summary_head_sha: request.head_sha,
          generated_at: "2026-05-01T00:00:00.000Z",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary, readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const spawned = await spawnReviewSummary(${JSON.stringify(request)}, { runtime: "claude" });
      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        my_approval_sha: ${JSON.stringify(request.head_sha)},
        my_last_review_sha: ${JSON.stringify(request.head_sha)},
      });
      const summary = await spawned.done;
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  // Completion must not roll the signals back to the stale spawn-time request.
  assert.equal(result.summary.summary, "## Summary\nUpdated.");
  assert.equal(result.persisted.my_approval_sha, request.head_sha);
  assert.equal(result.persisted.my_last_review_sha, request.head_sha);
  assert.equal(result.persisted.review_state, "approved");
});

test("spawnReviewSummary preserves a newer task target reconciled during the run", () => {
  const workspace = setupRunnerWorkspace("review-runner-head-race-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "task-review-session",
        result:
          "## Summary\nReviewed old head.\n\n## Agent Status\nAgent status: ready_for_human_approval",
        is_error: false,
      }),
      sleepMs: 100,
    },
  });

  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    task_title: "Original task title",
    task_description: "Original goal",
    task_plan: "Original plan",
    head_sha: "old-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary, readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const spawned = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" }
      );
      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        head_sha: "new-head",
        updated_at: "2026-05-01T00:30:00.000Z",
        task_title: "Updated task title",
        task_description: "Updated goal",
        task_plan: "Updated plan",
      });
      const summary = await spawned.done;
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.persisted.source, "task");
  assert.equal(result.persisted.task_id, "task-1");
  assert.equal(result.persisted.task_title, "Updated task title");
  assert.equal(result.persisted.task_description, "Updated goal");
  assert.equal(result.persisted.task_plan, "Updated plan");
  assert.equal(result.persisted.head_sha, "new-head");
  assert.equal(result.persisted.summary, "");
  assert.equal(result.persisted.summary_head_sha, undefined);
  assert.equal(result.persisted.review_status, "pending_summary");
  assert.equal(result.persisted.review_state, "queued");
  assert.equal(result.persisted.agent_review_status, undefined);
});

test("spawnReviewSummary keeps a mid-flight change request over the run's verdict", () => {
  const workspace = setupRunnerWorkspace("review-runner-changes-preserve-");
  const scenarioFile = path.join(workspace, "scenario.json");
  // The run finishes with a non-blocking verdict; a human change request lands
  // while it is in flight. The verdict must not bury the human's decision.
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-changes",
        result:
          "## Summary\nUpdated.\n\n## Agent Status\nAgent status: ready_for_human_approval",
        is_error: false,
      }),
      sleepMs: 100,
    },
  });

  const request = sampleRequest({ my_changes_requested_sha: undefined });
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old summary",
          summary_head_sha: request.head_sha,
          generated_at: "2026-05-01T00:00:00.000Z",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary, readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const spawned = await spawnReviewSummary(${JSON.stringify(request)}, { runtime: "claude" });
      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        my_changes_requested_sha: ${JSON.stringify(request.head_sha)},
        my_last_review_sha: ${JSON.stringify(request.head_sha)},
      });
      const summary = await spawned.done;
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  // The run parsed a ready_for_human_approval verdict, but the preserved change
  // request supersedes it in the derived state.
  assert.equal(
    result.persisted.agent_review_status,
    "ready_for_human_approval"
  );
  assert.equal(result.persisted.my_changes_requested_sha, request.head_sha);
  assert.equal(result.persisted.review_state, "changes_requested");
});

test("summarizePR resumes cached review sessions for changed PRs", () => {
  const workspace = setupRunnerWorkspace("review-runner-stale-resume-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-2",
        result:
          "## Summary\nFollow-up review.\n\n## Agent Status\nAgent status: needs_author_changes",
        is_error: false,
        duration_ms: 123,
      }),
    },
  });

  const request = sampleRequest({ head_sha: "new-head" });
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...sampleRequest({ head_sha: "old-head" }),
          summary: "old summary",
          summary_head_sha: "old-head",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
          effort: "max",
          model: "claude-sonnet-4-6",
          session_profile: {
            runtime: "claude",
            effort: "max",
            model: "claude-sonnet-4-6",
          },
          session_id: "claude-session-1",
          agent_review_status: "ready_for_human_approval",
          followups: [
            {
              asked_at: "2026-05-01T00:00:00.000Z",
              question: "What changed?",
              answered_at: "2026-05-01T00:00:01.000Z",
              answer: "Old answer",
              resumed: true,
            },
          ],
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        args,
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );

  assert.equal(result.args.args.includes("--resume"), true);
  assert.equal(result.args.args.includes("claude-session-1"), true);
  assert.match(result.args.args.join("\n"), /follow-up review/i);
  assert.match(result.args.args.join("\n"), /prior agent-authored comments/i);
  assert.equal(result.summary.summary_head_sha, "new-head");
  assert.equal(result.summary.session_id, "claude-session-2");
  assert.equal(result.summary.agent_review_status, "needs_author_changes");
  assert.equal(result.summary.followups.length, 1);
  assert.equal(result.persisted.agent_review_status, "needs_author_changes");
});

test("summarizePR starts fresh when the configured review profile changed", () => {
  const workspace = setupRunnerWorkspace("review-runner-profile-change-", {
    review_runtime: "claude",
    review_effort: "high",
    review_model: "claude-new-model",
  });
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "fresh-session",
        result: "## Summary\nFresh review.",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ head_sha: "new-head" });
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify({
      [request.pr_url]: {
        ...sampleRequest({ head_sha: "old-head" }),
        summary: "old summary",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:00:00.000Z",
        runtime: "claude",
        effort: "max",
        model: "claude-old-model",
        session_profile: {
          runtime: "claude",
          effort: "max",
          model: "claude-old-model",
        },
        session_id: "old-session",
      },
    })
  );

  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)});
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        args,
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );

  assert.equal(result.args.args.includes("--resume"), false);
  assert.equal(result.args.args.includes("old-session"), false);
  assert.equal(result.summary.session_id, "fresh-session");
  assert.equal(result.persisted.model, "claude-new-model");
  assert.equal(result.persisted.effort, "high");
  assert.deepEqual(result.persisted.session_profile, {
    runtime: "claude",
    effort: "high",
    model: "claude-new-model",
  });
});

test("summarizePR persists Codex output as a ReviewSummary", () => {
  const workspace = setupRunnerWorkspace("review-runner-codex-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const codexStdout = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "## Summary\nCodex pass." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
    "",
  ].join("\n");
  writeJson(scenarioFile, { codex: { stdout: codexStdout } });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
    head_sha: "def456",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "codex" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.summary.summary, "## Summary\nCodex pass.");
  assert.equal(result.summary.session_id, "codex-thread-1");
  assert.equal(result.summary.runtime, "codex");
  assert.equal(result.summary.input_tokens, 5);
  assert.equal(result.summary.output_tokens, 7);
  assert.equal(result.summary.summary_head_sha, "def456");
  assert.equal(result.persisted.summary_head_sha, "def456");
  assert.equal(result.persisted.session_id, "codex-thread-1");
});

test("summarizePR records error and preserves previous summary on non-zero exit", () => {
  const workspace = setupRunnerWorkspace("review-runner-error-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: { stderr: "boom", exitCode: 7 },
  });

  const request = sampleRequest();
  // Seed an existing summary to confirm it isn't wiped by a failed retry.
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old text",
          summary_head_sha: request.head_sha,
          generated_at: "2026-05-01T00:00:00.000Z",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.ok(result.summary.error, "error should be populated");
  assert.match(result.summary.error, /boom|claude exited with code 7/);
  assert.equal(typeof result.summary.error_at, "string");
  assert.equal(result.summary.summary, "old text");
  assert.equal(result.summary.summary_head_sha, request.head_sha);
  assert.equal(result.persisted.summary, "old text");
  assert.equal(result.persisted.summary_head_sha, request.head_sha);
  assert.equal(result.persisted.error_at, result.summary.error_at);
});

test("summarizePR applies the configured task run timeout", () => {
  const workspace = setupRunnerWorkspace("review-runner-timeout-", {
    task_run_timeout_ms: 25,
  });
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-slow",
        result: "too late",
        is_error: false,
      }),
      sleepMs: 200,
    },
  });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/3",
    pr_number: 3,
    head_sha: "slow123",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.match(result.summary.error, /Run timed out after 25ms/);
  assert.equal(result.summary.summary, "");
  assert.equal(result.summary.current_run_pid, undefined);
  assert.match(result.persisted.error, /Run timed out after 25ms/);
});

test("askFollowup throws when the cached entry has no summary yet", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-empty-");
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  const request = sampleRequest();
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "",
          generated_at: "",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let error = null;
      try {
        await askFollowup(${JSON.stringify(request.pr_url)}, "ping");
      } catch (err) {
        error = err.message;
      }
      console.log(JSON.stringify({ error }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.error, "Summary is not yet available for this PR.");
});

test("askFollowup allows stale summaries but still throws for active refreshes", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-refreshing-");
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  const argsFile = path.join(workspace, "agent-args.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  const request = sampleRequest({ head_sha: "new-head" });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old text",
          summary_head_sha: "old-head",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const staleFollowup = await askFollowup(${JSON.stringify(request.pr_url)}, "ping");

      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        summary_head_sha: ${JSON.stringify(request.head_sha)},
        current_run_pid: 123,
      });
      let runningError = null;
      try {
        await askFollowup(${JSON.stringify(request.pr_url)}, "ping");
      } catch (err) {
        runningError = err.message;
      }
      console.log(JSON.stringify({ staleFollowup, runningError }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_ARGS_FILE: argsFile,
      FAKE_AGENT_STDOUT: JSON.stringify({
        session_id: "followup-session",
        result: "Answered stale.",
        is_error: false,
        duration_ms: 200,
      }),
    }
  );

  assert.equal(result.staleFollowup.answer, "Answered stale.");
  assert.equal(result.staleFollowup.resumed, false);
  assert.equal(result.runningError, "Summary is being refreshed for this PR.");

  const argsPayload = JSON.parse(readFileSync(argsFile, "utf-8"));
  const promptIndex = argsPayload.args.indexOf("-p") + 1;
  assert.match(argsPayload.args[promptIndex], /Summary head SHA: old-head/);
  assert.match(argsPayload.args[promptIndex], /Current head SHA: new-head/);
});

test("askFollowup throws when the PR has no cached summary", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-missing-");

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let error = null;
      try {
        await askFollowup("https://github.com/acme/widget/pull/999", "ping");
      } catch (err) {
        error = err.message;
      }
      console.log(JSON.stringify({ error }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(
    result.error,
    "No summary to follow up on; generate one first."
  );
});

test("askFollowup resumes the cached session on the happy path", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-resume-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-1",
        result: "Answered via resume.",
        is_error: false,
        duration_ms: 200,
      }),
    },
  });

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "previous summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
          effort: "max",
          model: "claude-sonnet-4-6",
          session_profile: {
            runtime: "claude",
            effort: "max",
            model: "claude-sonnet-4-6",
          },
          session_id: "claude-session-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what does it do?");
      console.log(JSON.stringify(followup));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.resumed, true);
  assert.equal(result.answer, "Answered via resume.");
  assert.equal(result.session_id, "claude-session-1");
  assert.deepEqual(result.session_profile, {
    runtime: "claude",
    effort: "max",
    model: "claude-sonnet-4-6",
  });
  assert.equal(result.error, undefined);
});

test("askFollowup falls back to a fresh session when resume fails", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-fallback-");
  // Replace the fake claude with one that fails when --resume is passed and
  // succeeds otherwise, so we exercise both code paths from a single test.
  const claudePath = path.join(workspace, "bin", "claude");
  writeFileSync(
    claudePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--resume")) {
  process.stderr.write("session not found");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(
      JSON.stringify({
        session_id: "claude-session-2",
        result: "Answered freshly.",
        is_error: false,
        duration_ms: 200,
      })
    )});
`
  );
  chmodSync(claudePath, 0o755);

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "previous summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
          effort: "max",
          model: "claude-sonnet-4-6",
          session_profile: {
            runtime: "claude",
            effort: "max",
            model: "claude-sonnet-4-6",
          },
          session_id: "claude-session-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what does it do?");
      console.log(JSON.stringify(followup));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.resumed, false);
  assert.equal(result.answer, "Answered freshly.");
  assert.equal(result.session_id, "claude-session-2");
});

test("appendFollowup adds entries to the cached transcript", () => {
  const workspace = setupRunnerWorkspace("review-runner-append-");
  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          followups: [],
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { appendFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const followup = {
        asked_at: "2026-05-02T00:00:00.000Z",
        question: "what?",
        answered_at: "2026-05-02T00:00:01.000Z",
        answer: "this",
        resumed: true,
      };
      const updated = await appendFollowup(${JSON.stringify(request.pr_url)}, followup);
      console.log(JSON.stringify({
        updated,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.updated.followups.length, 1);
  assert.equal(result.updated.followups[0].question, "what?");
  assert.equal(result.persisted.followups.length, 1);
});

test("appendFollowup returns undefined for unknown pr_urls", () => {
  const workspace = setupRunnerWorkspace("review-runner-append-missing-");
  const result = runTsxScript(
    workspace,
    [
      `import { appendFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const updated = await appendFollowup(
        "https://github.com/missing/repo/pull/9",
        {
          asked_at: "2026-05-02T00:00:00.000Z",
          question: "?",
          answered_at: "2026-05-02T00:00:01.000Z",
          answer: "",
          resumed: false,
        }
      );
      console.log(JSON.stringify({ updated: updated ?? null }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.updated, null);
});

test("askFollowup over codex uses the resume flow when a session id is cached", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-codex-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const codexStdout = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Codex follow-up answer." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
    "",
  ].join("\n");
  writeJson(scenarioFile, { codex: { stdout: codexStdout } });

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "prior summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "codex",
          effort: "xhigh",
          model: "gpt-5.4",
          session_profile: {
            runtime: "codex",
            effort: "xhigh",
            model: "gpt-5.4",
          },
          session_id: "codex-thread-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what next?");
      console.log(JSON.stringify(followup));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.resumed, true);
  assert.equal(result.answer, "Codex follow-up answer.");
  assert.equal(result.session_id, "codex-thread-1");
});

test("summarizePR over codex records an error on non-zero exit", () => {
  const workspace = setupRunnerWorkspace("review-runner-codex-error-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    codex: { stderr: "codex blew up", exitCode: 5 },
  });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/77",
    pr_number: 77,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "codex" });
      console.log(JSON.stringify(summary));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );
  assert.ok(result.error, "error should be populated");
  assert.match(result.error, /codex blew up|codex exited with code 5/);
});

test("spawnReviewSummary invokes the onComplete hook with the final summary", () => {
  const workspace = setupRunnerWorkspace("review-runner-onComplete-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-x",
        result: "Looks good.",
        is_error: false,
        duration_ms: 5,
      }),
    },
  });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/100",
    pr_number: 100,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let onCompleteSeen = null;
      const spawned = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" },
        (summary) => { onCompleteSeen = summary; }
      );
      const final = await spawned.done;
      console.log(JSON.stringify({
        pid: typeof spawned.pid,
        final: { summary: final.summary, runtime: final.runtime },
        onCompleteSeenSummary: onCompleteSeen ? onCompleteSeen.summary : null,
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.pid, "number");
  assert.equal(result.final.summary, "Looks good.");
  assert.equal(result.final.runtime, "claude");
  assert.equal(result.onCompleteSeenSummary, "Looks good.");
});

test("spawnReviewSummary atomically rejects a duplicate run for the same PR", () => {
  const workspace = setupRunnerWorkspace("review-runner-claim-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claimed-session",
        result: "## Summary\nClaimed.",
        is_error: false,
      }),
      sleepMs: 150,
    },
  });
  const request = sampleRequest();

  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const first = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" }
      );
      let duplicateError = "";
      try {
        await spawnReviewSummary(
          ${JSON.stringify(request)},
          { runtime: "claude" }
        );
      } catch (error) {
        duplicateError = error instanceof Error ? error.message : String(error);
      }
      const completed = await first.done;
      const afterRelease = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" }
      );
      await afterRelease.done;
      console.log(JSON.stringify({ duplicateError, completed }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.match(result.duplicateError, /already in flight/);
  assert.equal(result.completed.current_run_pid, undefined);
  assert.equal(result.completed.current_run_id, undefined);
});

test("disk write race does not corrupt reviews.json under concurrent summarizations", () => {
  // Smoke test that the store mutex serialises writes from two summary runs.
  const workspace = setupRunnerWorkspace("review-runner-concurrent-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "s",
        result: "ok",
        is_error: false,
        duration_ms: 1,
      }),
    },
  });

  const requestA = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/10",
    pr_number: 10,
  });
  const requestB = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/11",
    pr_number: 11,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await Promise.all([
        summarizePR(${JSON.stringify(requestA)}, { runtime: "claude" }),
        summarizePR(${JSON.stringify(requestB)}, { runtime: "claude" }),
      ]);
      console.log(JSON.stringify(Object.keys(readReviewSummaryMap()).sort()));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );
  assert.deepEqual(result, [requestA.pr_url, requestB.pr_url]);
  // Final file is parseable JSON with both entries.
  const persisted = JSON.parse(
    readFileSync(path.join(workspace, ".cortex", "reviews.json"), "utf-8")
  );
  assert.deepEqual(
    Object.keys(persisted).sort(),
    [requestA.pr_url, requestB.pr_url].sort()
  );
});
