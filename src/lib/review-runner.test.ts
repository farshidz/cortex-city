import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  buildReviewReplyPrompt,
  buildReviewTier1Prompt,
  buildReviewWrapperPrompt,
  DEFAULT_REVIEW_PROMPT,
  isReviewSessionCompatible,
  isReviewTieringEnabled,
  parseReviewAgentStatus,
  parseReviewerHumanDecisionBody,
  parseReviewReplyStatus,
  parseReviewTier1Status,
  resolveReviewOpts,
  resolveReviewPrompt,
  resolveReviewTierOpts,
  spawnRuntime,
} from "./review-runner";
import {
  createTempWorkspace,
  moduleUrl,
  prependBinToPath,
  runTsxScript,
  writeFakeAgentBinary,
  writeFakeGhBinary,
  writeJson,
  writeTestConfig,
} from "./test-harness";
import type {
  OrchestratorConfig,
  ReviewerCommentDelivery,
  ReviewerCommentReceipt,
  ReviewRequest,
  ReviewSummary,
} from "./types";

const REVIEW_RUNNER_MODULE_URL = moduleUrl("src/lib/review-runner.ts");
const REVIEW_STORE_MODULE_URL = moduleUrl("src/lib/review-store.ts");
const GITHUB_MODULE_URL = moduleUrl("src/lib/github.ts");

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

function approvedReview(commitId: string) {
  return {
    id: 91,
    state: "APPROVED",
    commit_id: commitId,
    submitted_at: "2026-05-01T00:20:00.000Z",
    user: { login: "me" },
  };
}

function reviewerCommentBody(
  message: string,
  token: string,
  kind: "human_decision" | "manual_approval" = "human_decision"
): string {
  const prefix =
    kind === "human_decision"
      ? "**🤖[Cortex City Reviewer]** **Human decision needed:**"
      : "**🤖[Cortex City Reviewer]** **Ready for manual approval:**";
  return `${prefix} ${message}\n\n<!-- cortex-city-review-decision:${token} -->`;
}

function reviewerDelivery(
  token: string,
  message: string,
  headSha = "abc123",
  kind: "human_decision" | "manual_approval" = "human_decision"
): ReviewerCommentDelivery {
  return {
    action_token: token,
    kind,
    head_sha: headSha,
    body: reviewerCommentBody(message, token, kind),
  };
}

function reviewerReceipt(
  delivery: ReviewerCommentDelivery,
  commentId: number,
  authorLogin = "me"
): ReviewerCommentReceipt {
  return {
    action_token: delivery.action_token,
    comment_id: commentId,
    author_login: authorLogin,
    body_sha256: createHash("sha256").update(delivery.body).digest("hex"),
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
  writeFakeGhBinary(workspace);
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
  assert.match(taskPrompt, /Use the `gh` CLI for GitHub inspection and comments/);
  assert.match(taskPrompt, /Review source: task-owned pull request/);
  assert.match(taskPrompt, /never approve it or request changes on GitHub/i);
  assert.match(taskPrompt, /specific, actionable GitHub comments/i);
  assert.match(
    taskPrompt,
    /Start every GitHub comment you post with `\*\*🤖\[Cortex City Reviewer\]\*\*`/
  );
  assert.match(
    taskPrompt,
    /every GitHub comment authored by the reviewer as immutable timeline history/i
  );
  assert.match(
    taskPrompt,
    /Never edit or delete an earlier reviewer comment/i
  );
  assert.match(
    taskPrompt,
    /\*\*🤖\[Cortex City Reviewer\]\*\* \*\*Human decision needed:\*\*/
  );
  assert.match(taskPrompt, /Task ID: task-42/);
  assert.match(taskPrompt, /Improve keyboard navigation/);
  assert.match(taskPrompt, /Make every dialog keyboard accessible/);
  assert.match(taskPrompt, /Add focus trapping/);
  assert.match(taskPrompt, /Check the task's accessibility requirements/);
  assert.match(taskPrompt, /never authorizes self-approval/i);
  assert.match(taskPrompt, /Do not approve this PR on GitHub/i);
  assert.match(
    taskPrompt,
    /GitHub does not allow an author to approve their own PR/i
  );
  assert.match(taskPrompt, /leave a top-level PR conversation comment/i);
  assert.match(taskPrompt, /requires an eligible non-author reviewer/i);
  assert.match(taskPrompt, /final status is `needs_human_decision`/i);
  assert.match(taskPrompt, /including task-owned and other self-authored PRs/i);
  assert.match(taskPrompt, /add a `## Human Decision` section/i);
  assert.match(taskPrompt, /Do not post this comment yourself/i);
  assert.match(taskPrompt, /do not invent or report a comment ID/i);
  assert.match(taskPrompt, /Cortex City will create exactly one top-level/i);

  const inboundPrompt = buildReviewWrapperPrompt(config, sampleRequest());
  assert.match(inboundPrompt, /Review source: inbound pull request/);
  assert.match(inboundPrompt, /someone else's PR/);
  assert.doesNotMatch(inboundPrompt, /accessibility requirements/);
  assert.doesNotMatch(inboundPrompt, /Cortex task context/);
  assert.match(
    inboundPrompt,
    /final status is `ready_for_human_approval`[\s\S]*approve the reviewed commit on GitHub/i
  );
  assert.match(inboundPrompt, /--raw-field commit_id=<reviewed SHA>/);
  assert.match(inboundPrompt, /Never use `gh pr review --approve`/);
  assert.match(inboundPrompt, /Immediately before the API call/i);
  assert.match(inboundPrompt, /latest submitted decisive review/i);
  assert.match(inboundPrompt, /do not approve or overwrite it/i);
  assert.match(inboundPrompt, /final status is `needs_human_decision`/i);
  assert.match(inboundPrompt, /Cortex City will create exactly one top-level/i);
  assert.match(inboundPrompt, /Do not submit a change-request review decision/i);

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
  assert.match(selfAuthoredPrompt, /Do not approve this PR on GitHub/i);
  assert.match(selfAuthoredPrompt, /leave a top-level PR conversation comment/i);
  assert.match(selfAuthoredPrompt, /Do not post that handoff comment yourself/i);
  assert.match(selfAuthoredPrompt, /final status is `needs_human_decision`/i);
  assert.doesNotMatch(
    selfAuthoredPrompt,
    /--raw-field commit_id=<reviewed SHA>/
  );
  assert.doesNotMatch(selfAuthoredPrompt, /someone else's PR/);

  const changeRequestedPrompt = buildReviewWrapperPrompt(
    config,
    sampleRequest({ my_changes_requested_sha: "abc123" })
  );
  assert.match(changeRequestedPrompt, /already has a current `CHANGES_REQUESTED`/);
  assert.match(changeRequestedPrompt, /Do not overwrite that decision/i);
  assert.match(changeRequestedPrompt, /use `needs_human_decision`/i);
  assert.doesNotMatch(
    changeRequestedPrompt,
    /--raw-field commit_id=<reviewed SHA>/
  );
});

test("buildReviewWrapperPrompt uses source-specific scope authority", () => {
  const config = baseConfig({ review_learning_enabled: false });
  const inboundPrompt = buildReviewWrapperPrompt(config, sampleRequest());
  const taskPrompt = buildReviewWrapperPrompt(
    config,
    sampleRequest({
      source: "task",
      task_id: "task-42",
      task_title: "Keep the change focused",
      task_description: "Implement only the requested behavior.",
      task_plan: "Make the smallest safe change.",
    })
  );

  assert.match(inboundPrompt, /Scope authority/i);
  assert.match(inboundPrompt, /PR's stated goal.*repository's existing contracts/i);
  assert.doesNotMatch(
    inboundPrompt,
    /supplied Cortex task title|original task|task requirements|the builder/i
  );

  assert.match(taskPrompt, /Scope authority/i);
  assert.match(taskPrompt, /supplied Cortex task title, description, and plan/i);
  assert.match(taskPrompt, /<task_title>\s*Keep the change focused\s*<\/task_title>/i);

  for (const prompt of [inboundPrompt, taskPrompt]) {
    assert.match(prompt, /severity separately from the scope of its remedy/i);
    assert.match(prompt, /Size and locality are the test, not the topic/i);
    assert.match(
      prompt,
      /`needs_human_decision`, not `needs_author_changes`/i
    );
    assert.match(prompt, /Earlier reviewer comments are not requirements/i);
    assert.match(
      prompt,
      /\*\*Separate follow-up suggested \(non-blocking\):\*\*/
    );
    assert.match(
      prompt,
      /Do not ask for that work to be implemented in the current PR/i
    );
  }
});

test("buildReviewWrapperPrompt routes blocking scope calls to a human", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  assert.match(
    prompt,
    /needs_human_decision.*blocking issue whose smallest correct fix would materially expand the PR/i
  );
  assert.match(
    prompt,
    /needs_human_decision`, not `needs_author_changes`/i
  );
  assert.match(prompt, /points or blocking issue.*decision the human needs to make/i);
});

test("buildReviewWrapperPrompt stays within its protocol size budget", () => {
  const config = baseConfig({ review_learning_enabled: false });
  const wordCount = (value: string) => value.trim().split(/\s+/).length;

  for (const request of [
    sampleRequest(),
    sampleRequest({
      source: "task",
      task_id: "task-42",
      task_title: "Keep the change focused",
    }),
  ]) {
    assert.ok(
      wordCount(buildReviewWrapperPrompt(config, request)) < 1_450,
      "merge or shorten existing protocol rules before raising the size budget"
    );
  }
});

test("buildReviewWrapperPrompt keeps broader improvements non-blocking", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  assert.match(
    prompt,
    /\*\*Separate follow-up suggested \(non-blocking\):\*\*/
  );
  assert.match(prompt, /separate task and PR/i);
  assert.match(
    prompt,
    /Do not ask for that work to be implemented in the current PR/i
  );
  assert.match(
    prompt,
    /must not by itself produce `needs_author_changes` or `needs_human_decision`/i
  );
});

test("buildReviewWrapperPrompt caps finding families and resolves ambiguity toward variants", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  assert.match(prompt, /Group every finding by root cause/i);
  assert.match(
    prompt,
    /materially distinct root cause, or a regression the latest fix introduced/i
  );
  assert.match(prompt, /treat it as a variant/i);
  assert.match(prompt, /Novelty is the claim that needs justification/i);
  assert.match(
    prompt,
    /three separate rounds have each reported a new variant of one family, stop/i
  );
  assert.match(prompt, /convert the family to residual risk/i);
  assert.match(prompt, /`needs_human_decision` once for it/);
  assert.match(prompt, /Never re-raise a family a human has already ruled on/i);
});

test("buildReviewWrapperPrompt counts variants by round so the sibling sweep survives", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  // A first round that finds four siblings of one family reports one finding
  // listing all four; that is one variant, so the cap cannot fire on round one
  // and cannot force a locally fixable invariant to `needs_human_decision`.
  assert.match(prompt, /Count a family's variants by round, not by case/i);
  assert.match(
    prompt,
    /sibling case you report together in one finding counts as one reported variant/i
  );
  assert.match(prompt, /never limits the same-round sibling sweep/i);
  assert.match(
    prompt,
    /never converts a family you are reporting for the first time/i
  );
  // The sibling sweep it protects is still required, in the same round.
  assert.match(prompt, /test the obvious sibling cases in the same round/i);
  assert.match(prompt, /list every case you found in that one finding/i);
});

test("buildReviewWrapperPrompt leaves Cortex City the only human-decision poster", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  // The cap path must not assign a second top-level post: the conversion goes
  // on the existing threads plus the generated section, and Cortex City creates
  // the single receipted PR conversation event.
  assert.match(
    prompt,
    /reply on its existing threads to say you are converting it/i
  );
  assert.match(
    prompt,
    /put the risk that remains in the generated `## Human Decision` section/i
  );
  assert.match(prompt, /Do not post a top-level conversion comment yourself/i);
  assert.match(
    prompt,
    /Cortex City will create exactly one top-level PR conversation comment from that section/
  );
});

test("buildReviewWrapperPrompt requires rule-level findings and de-duplicated decisions", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest()
  );

  assert.match(prompt, /Report the broken rule, not one example of it/i);
  assert.match(prompt, /state the invariant/i);
  assert.match(prompt, /test the obvious sibling cases in the same round/i);
  assert.match(prompt, /list every case you found in that one finding/i);
  assert.match(prompt, /request the fix at the level of the rule/i);
  assert.match(
    prompt,
    /Before raising `needs_human_decision`, search your own prior comments/i
  );
  assert.match(prompt, /binding scope: apply it and do not ask again/i);
});

test("buildReviewWrapperPrompt scopes follow-up reviews to prior findings and the revision diff", () => {
  const config = baseConfig({
    review_learning_enabled: false,
    review_prompt: "Review every PR broadly and surface all findings.",
  });
  const cached = {
    ...sampleRequest({ head_sha: "previous-head" }),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "previous-head",
    session_id: "stored-session",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "needs_review",
    review_state: "needs_review",
  } satisfies ReviewSummary;

  const prompt = buildReviewWrapperPrompt(
    config,
    sampleRequest({ head_sha: "current-head" }),
    cached
  );

  assert.match(prompt, /follow-up round in verification mode, not a full re-review/i);
  assert.match(prompt, /Previously reviewed head: previous-head/);
  assert.match(prompt, /Current head: current-head/);
  assert.match(prompt, /This session is fresh and has no memory of the earlier rounds/i);
  assert.match(
    prompt,
    /<previous_review>\n## Summary\nPreviously reviewed\.\n<\/previous_review>/
  );
  assert.match(
    prompt,
    /using GitHub tooling to inspect your own prior reviewer comments/i
  );
  assert.match(prompt, /enumerate the findings you reported/i);
  assert.match(prompt, /Verify each enumerated finding at the current head/i);
  assert.match(prompt, /running the repro or check you recorded for it/i);
  // Both comment surfaces get an action that exists on that surface: an inline
  // thread can be resolved, a PR conversation comment cannot.
  assert.match(prompt, /report it on the same GitHub surface/i);
  assert.match(
    prompt,
    /inline review thread: reply on that thread with what you verified/i
  );
  assert.match(
    prompt,
    /resolve the thread only when the finding is fixed at the current head/i
  );
  assert.match(prompt, /Leave it unresolved otherwise/i);
  assert.match(
    prompt,
    /PR conversation comment, which has no thread and cannot be resolved: post a new top-level comment/i
  );
  assert.match(
    prompt,
    /Resolving one is never an action you owe, so its absence is not a reason to return `blocked`/i
  );
  assert.match(
    prompt,
    /Limit new discovery to the changes between the previously reviewed head/i
  );
  assert.match(prompt, /gate every new finding on the family rules above/i);
  assert.match(prompt, /Earlier reviewer comments are not requirements/i);
  assert.match(prompt, /unchanged code unless the issue is critical/i);
  assert.match(prompt, /return a clean status/i);
  assert.doesNotMatch(prompt, /Review the current PR fresh as well/i);
  assert.doesNotMatch(prompt, /This is the round in which to sweep/i);
});

test("buildReviewWrapperPrompt gates follow-up comments on a changed finding state", () => {
  const cached = {
    ...sampleRequest({ head_sha: "previous-head" }),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "previous-head",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "needs_review",
    review_state: "needs_review",
  } satisfies ReviewSummary;

  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "current-head" }),
    cached
  );

  // A comment is owed for a change in the finding's state, and the states that
  // count are enumerated so an unchanged finding cannot qualify.
  assert.match(
    prompt,
    /Post a GitHub comment for a verified finding only when this round changes what its thread or comment already says/i
  );
  assert.match(prompt, /you are withdrawing it as out of scope/i);
  assert.match(prompt, /remaining ask is now materially narrower or wider/i);
  assert.match(
    prompt,
    /materially different failure than the one already recorded/i
  );
  // The two non-changes that produced the duplicate comments this rule exists
  // to stop: re-running the same check, and a new head SHA.
  assert.match(
    prompt,
    /Running the recorded check and getting the recorded result is not a change, and neither is a new head SHA/i
  );
  assert.match(
    prompt,
    /still unfixed and otherwise unchanged owes no comment on either surface/i
  );
  // Silence on an unchanged finding must not read as an unfinished action.
  assert.match(prompt, /never return `blocked` over it/i);
  assert.match(
    prompt,
    /Report every finding that remains open in the generated review's findings and in the agent status/i
  );
});

test("buildReviewWrapperPrompt sweeps sibling cases on initial reviews", () => {
  const prompt = buildReviewWrapperPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "initial-head" })
  );

  assert.match(prompt, /This is an initial review of the current PR state/);
  assert.match(prompt, /This is the round in which to sweep for sibling cases/i);
  assert.match(
    prompt,
    /check the whole diff for other places that break the same rule now/i
  );
  assert.doesNotMatch(prompt, /not a full re-review/i);
  assert.doesNotMatch(prompt, /Verify each enumerated finding/i);
});

test("reviewer tiering is off until tier 1 is configured", () => {
  const config = baseConfig({
    review_runtime: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });

  assert.equal(isReviewTieringEnabled(config), false);
  assert.equal(isReviewTieringEnabled({ ...config, reviewer_tiers: {} }), false);
  assert.equal(
    isReviewTieringEnabled({ ...config, reviewer_tiers: { tier1: {} } }),
    false
  );
  assert.equal(
    isReviewTieringEnabled({
      ...config,
      reviewer_tiers: { tier1: { effort: "low" } },
    }),
    true
  );

  // With no tier block, both tiers resolve to the single reviewer profile.
  for (const tier of [1, 2] as const) {
    assert.deepEqual(resolveReviewTierOpts(config, tier), {
      runtime: "codex",
      effort: "high",
      model: "gpt-5.6-sol",
    });
  }

  const tiered = {
    ...config,
    reviewer_tiers: {
      tier1: { runtime: "codex" as const, model: "gpt-5.4", effort: "low" as const },
      tier2: { effort: "xhigh" as const },
    },
  };
  assert.deepEqual(resolveReviewTierOpts(tiered, 1), {
    runtime: "codex",
    effort: "low",
    model: "gpt-5.4",
  });
  assert.deepEqual(resolveReviewTierOpts(tiered, 2), {
    runtime: "codex",
    effort: "xhigh",
    model: "gpt-5.6-sol",
  });
});

test("buildReviewTier1Prompt seeds pointers and forbids a terminal verdict", () => {
  const cached = {
    ...sampleRequest({ head_sha: "old-head" }),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "old-head",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "new_commits",
    review_state: "re_reviewing",
  } satisfies ReviewSummary;
  const prompt = buildReviewTier1Prompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "new-head" }),
    cached,
    [
      {
        thread_id: "PRRT_kw1",
        url: "https://github.com/acme/widget/pull/1#discussion_r1",
        first_line: "This guard is inverted.",
      },
    ]
  );

  assert.match(prompt, /verification round/i);
  assert.match(prompt, /not to review the PR again/i);
  assert.match(prompt, /Last reviewed head: old-head/);
  assert.match(prompt, /Current head: new-head/);
  assert.match(
    prompt,
    /<previous_review>\n## Summary\nPreviously reviewed\.\n<\/previous_review>/
  );
  assert.match(
    prompt,
    /- PRRT_kw1 \(https:\/\/github\.com\/acme\/widget\/pull\/1#discussion_r1\): This guard is inverted\./
  );
  assert.match(
    prompt,
    /must be one of: fixes_verified, needs_author_changes, escalate/
  );
  assert.match(prompt, /This is not an approval/i);
  assert.match(prompt, /Escalating is cheap and correct/i);
  // The cheap tier can neither approve nor declare a PR ready.
  assert.doesNotMatch(prompt, /ready_for_human_approval/);
  assert.doesNotMatch(prompt, /needs_human_decision/);

  const withoutThreads = buildReviewTier1Prompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "new-head" }),
    cached
  );
  assert.match(withoutThreads, /\(none listed/);
});

test("parseReviewTier1Status accepts only the tier-1 status space", () => {
  assert.equal(
    parseReviewTier1Status("## Agent Status\nAgent status: `fixes_verified`"),
    "fixes_verified"
  );
  assert.equal(
    parseReviewTier1Status("Agent status: needs_author_changes"),
    "needs_author_changes"
  );
  assert.equal(parseReviewTier1Status("Agent status: escalate"), "escalate");
  // A tier-1 round can never report a terminal verdict, however it phrases it.
  assert.equal(
    parseReviewTier1Status("Agent status: ready_for_human_approval"),
    undefined
  );
  assert.equal(
    parseReviewTier1Status("Agent status: needs_human_decision"),
    undefined
  );
  assert.equal(
    parseReviewTier1Status("Everything is fixes_verified as far as I can tell."),
    undefined
  );
});

test("buildReviewTier1Prompt carries the scope gate and both comment surfaces", () => {
  const cached = {
    ...sampleRequest({ head_sha: "old-head" }),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "old-head",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "new_commits",
    review_state: "re_reviewing",
  } satisfies ReviewSummary;
  const prompt = buildReviewTier1Prompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "new-head" }),
    cached
  );

  // A top-level PR comment has no resolvable thread, so the cheap tier needs the
  // same surface branching the full follow-up prompt has.
  assert.match(prompt, /report it on the surface the finding was posted on/i);
  assert.match(
    prompt,
    /inline review thread: reply on that thread with what you verified, and resolve it only when the finding is fixed/i
  );
  assert.match(
    prompt,
    /PR conversation comment, which has no thread and cannot be resolved: post a new top-level comment/i
  );
  assert.match(prompt, /owe no resolve for it/i);
  // And the scope gate, or it would enforce a request the full reviewer would
  // have withdrawn.
  assert.match(prompt, /Your earlier comments are not requirements/i);
  assert.match(prompt, /cannot settle whether a finding is in scope, use `escalate`/i);
  // Withdrawal has to route through the same surface rule, or the two
  // instructions contradict each other for an out-of-scope finding that was
  // posted as a PR conversation comment and has no thread to withdraw on.
  assert.match(
    prompt,
    /withdraw it instead of reporting it unfixed, on the same surface rule as above: a reply on its inline thread, or a new top-level comment when the finding was a PR conversation comment/i
  );
  assert.doesNotMatch(prompt, /withdraw it on its thread/i);
});

test("buildReviewTier1Prompt gates comments on a changed finding state", () => {
  const cached = {
    ...sampleRequest({ head_sha: "old-head" }),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "old-head",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "new_commits",
    review_state: "re_reviewing",
  } satisfies ReviewSummary;
  const prompt = buildReviewTier1Prompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest({ head_sha: "new-head" }),
    cached
  );

  // This tier runs on every new head, so it is the round most likely to restate
  // an unchanged finding.
  assert.match(
    prompt,
    /Comment only when this round changes what a finding's thread or comment already says/i
  );
  assert.match(
    prompt,
    /still unfixed and otherwise unchanged owes no comment/i
  );
  assert.match(
    prompt,
    /running the recorded check to the recorded result at a new head SHA is not a change/i
  );
  assert.match(prompt, /Report those findings in your own output instead/i);
  // Posting nothing is a valid round, so it must not be laundered into an
  // escalation.
  assert.match(
    prompt,
    /never return `escalate` merely because you posted nothing/i
  );
});

test("buildReviewReplyPrompt answers conversation without re-reviewing", () => {
  const cached = {
    ...sampleRequest(),
    summary: "## Summary\nPreviously reviewed.",
    summary_head_sha: "abc123",
    generated_at: "2026-05-01T00:10:00.000Z",
    review_status: "up_to_date",
    review_state: "reviewed",
  } satisfies ReviewSummary;
  const prompt = buildReviewReplyPrompt(
    baseConfig({ review_learning_enabled: false }),
    sampleRequest(),
    cached
  );

  assert.match(prompt, /answering conversation on a pull request you already reviewed/i);
  assert.match(prompt, /effective diff has not changed since your last round/i);
  assert.match(prompt, /do not re-review the diff/i);
  assert.match(prompt, /do not raise new findings/i);
  assert.match(
    prompt,
    /<previous_review>\n## Summary\nPreviously reviewed\.\n<\/previous_review>/
  );
  assert.match(prompt, /reply on the existing thread each one belongs to/i);
  // A reply round answers new conversation only; a quiet open thread is not an
  // invitation to restate its finding.
  assert.match(prompt, /Reply only where there is new conversation to answer/i);
  assert.match(
    prompt,
    /thread with nothing new since your last round owes no comment/i
  );
  assert.match(prompt, /do not post a reply that only restates it/i);
  assert.match(prompt, /withdraw any earlier request of yours/i);
  assert.match(
    prompt,
    /must be one of: replied, resolved, needs_human_decision, blocked/
  );
  assert.match(prompt, /leaves the standing review verdict as it is/i);
  // `resolved` is how a settled verdict gets replaced. It hands the diff to a
  // full review round rather than clearing the verdict itself.
  assert.match(prompt, /Use `resolved` when the conversation settled the standing verdict/);
  assert.match(prompt, /queues a full review round to replace it/i);
  assert.match(prompt, /Do not declare the PR ready yourself/i);
  // No standing verdict recorded, so none is named.
  assert.doesNotMatch(prompt, /Standing verdict from your last review round/);
  assert.match(prompt, /Do not approve, request changes, or submit any review decision/i);
  assert.match(prompt, /## Human Decision/);
  // A reply round has no summary to write and no approval to give.
  assert.doesNotMatch(prompt, /ready_for_human_approval/);
  assert.doesNotMatch(prompt, /Start the generated review with `## Summary`/);
});

test("parseReviewReplyStatus reads only the reply round's own status line", () => {
  assert.equal(
    parseReviewReplyStatus("## Agent Status\nAgent status: `replied`"),
    "replied"
  );
  assert.equal(
    parseReviewReplyStatus("Agent status: needs_human_decision"),
    "needs_human_decision"
  );
  assert.equal(parseReviewReplyStatus("Agent status: blocked"), "blocked");
  assert.equal(parseReviewReplyStatus("Agent status: `resolved`"), "resolved");
  // A quoted finding in the prose is not a status.
  assert.equal(
    parseReviewReplyStatus(
      "I withdrew my earlier needs_author_changes request.\nAgent status: replied"
    ),
    "replied"
  );
  assert.equal(
    parseReviewReplyStatus("I still think this is needs_author_changes."),
    undefined
  );
  assert.equal(
    parseReviewReplyStatus("Agent status: ready_for_human_approval"),
    undefined
  );
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

test("parseReviewerHumanDecisionBody reads only the dedicated section", () => {
  assert.equal(
    parseReviewerHumanDecisionBody(
      "## Agent Status\nAgent status: `needs_human_decision`\n\n## Human Decision\nChoose A or B.\n\n## Details\nInternal context."
    ),
    "Choose A or B."
  );
  assert.equal(
    parseReviewerHumanDecisionBody("Human Decision: Choose A or B."),
    undefined
  );
  assert.equal(
    parseReviewerHumanDecisionBody("## Human Decision\n\n## Details\nEmpty."),
    undefined
  );
});

test("spawnRuntime retains Claude workspaces while restoring bypass mode", () => {
  const workspace = setupRunnerWorkspace("review-runtime-workspace-claude-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  const reviewRoot = path.join(workspace, "review-scratch");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "contained-claude-session",
        result: "contained",
        is_error: false,
      }),
    },
  });

  const result = runTsxScript(
    workspace,
    [`import { spawnRuntime } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`],
    `
      const fs = await import("node:fs");
      const spawned = spawnRuntime(
        "claude",
        "review this PR",
        { runtime: "claude" },
        undefined,
        1_000,
        {},
        "https://github.com/acme/widget/pull/41"
      );
      const output = await spawned.done;
      const invocation = JSON.parse(fs.readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        output,
        invocation,
        workspaceExistsAfterDone: fs.existsSync(invocation.cwd),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      CORTEX_REVIEW_WORKSPACE_ROOT: reviewRoot,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );

  assert.equal(result.output.result_text, "contained");
  assert.equal(
    path.dirname(result.invocation.cwd),
    realpathSync(reviewRoot)
  );
  assert.match(path.basename(result.invocation.cwd), /^review-[a-f0-9]{64}$/);
  assert.equal(result.invocation.env.TMPDIR, result.invocation.cwd);
  assert.equal(result.invocation.env.TMP, result.invocation.cwd);
  assert.equal(result.invocation.env.TEMP, result.invocation.cwd);
  assert.equal(result.workspaceExistsAfterDone, true);
  assert.equal(result.invocation.args.includes("bypassPermissions"), true);
  assert.equal(result.invocation.args.includes("dontAsk"), false);
  assert.equal(result.invocation.args.includes("Bash(gh *)"), false);
});

test("spawnRuntime preserves Codex resume and bypass inside the retained PR workspace", () => {
  const workspace = setupRunnerWorkspace("review-runtime-workspace-codex-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  const reviewRoot = path.join(workspace, "review-scratch");
  writeJson(scenarioFile, {
    codex: {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "resumed" },
        }),
        "",
      ].join("\n"),
    },
  });

  const result = runTsxScript(
    workspace,
    [`import { spawnRuntime } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`],
    `
      const fs = await import("node:fs");
      const spawned = spawnRuntime(
        "codex",
        "follow up",
        { runtime: "codex", effort: "xhigh" },
        "codex-thread-1",
        1_000,
        {},
        "https://github.com/acme/widget/pull/42"
      );
      const output = await spawned.done;
      const invocation = JSON.parse(fs.readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        output,
        invocation,
        workspaceExistsAfterDone: fs.existsSync(invocation.cwd),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      CORTEX_REVIEW_WORKSPACE_ROOT: reviewRoot,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );

  assert.equal(result.output.result_text, "resumed");
  assert.equal(result.invocation.env.TMPDIR, result.invocation.cwd);
  assert.equal(result.workspaceExistsAfterDone, true);
  assert.ok(
    result.invocation.args.includes(
      "--dangerously-bypass-approvals-and-sandbox"
    )
  );
  assert.ok(!result.invocation.args.includes("workspace-write"));
  assert.ok(result.invocation.args.includes("--skip-git-repo-check"));
  assert.ok(result.invocation.args.includes("resume"));
  assert.ok(result.invocation.args.includes("codex-thread-1"));
  assert.ok(result.invocation.args.includes("follow up"));
  assert.ok(
    result.invocation.args.indexOf("--skip-git-repo-check") <
      result.invocation.args.indexOf("resume")
  );
});

test("spawnRuntime removes its workspace when the runtime cannot start", () => {
  const workspace = setupRunnerWorkspace("review-runtime-spawn-error-");
  const reviewRoot = path.join(workspace, "review-scratch");
  const result = runTsxScript(
    workspace,
    [`import { spawnRuntime } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`],
    `
      const fs = await import("node:fs");
      process.env.PATH = ${JSON.stringify(path.join(workspace, "missing-bin"))};
      const output = await spawnRuntime(
        "claude",
        "review",
        { runtime: "claude" },
        undefined,
        1_000
      ).done;
      console.log(JSON.stringify({
        output,
        leftovers: fs.readdirSync(${JSON.stringify(reviewRoot)}),
      }));
    `,
    { ...prependBinToPath(workspace), CORTEX_REVIEW_WORKSPACE_ROOT: reviewRoot }
  );

  assert.match(result.output.error, /ENOENT|spawn claude/);
  assert.deepEqual(result.leftovers, []);
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

test("summarizePR receipts the comments its run posted on every surface", () => {
  const workspace = setupRunnerWorkspace("review-runner-comment-receipts-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const reviewerFinding = "**🤖[Cortex City Reviewer]** The guard is inverted.";
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        // Stands in for the comments the reviewer posts with `gh` inside its
        // own run: an inline finding, its wrapping COMMENTED review, a
        // conversation summary, and a participant's reply.
        comments: [
          {
            id: 700,
            pull_request_review_id: 40,
            body: reviewerFinding,
            user: { login: "me" },
          },
        ],
        reviews: [{ id: 40, state: "COMMENTED", body: "", user: { login: "me" } }],
        issueComments: [
          { id: 800, body: reviewerFinding, user: { login: "me" } },
          { id: 801, body: "Looks wrong to me too.", user: { login: "octocat" } },
        ],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-1",
        result:
          "## Summary\nOne finding posted.\n\n## Agent Status\nAgent status: needs_author_changes",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { getPRStateHash, getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        stateHash: await getPRStateHash(${JSON.stringify(request.pr_url)}),
        submitted: await getSubmittedCommentIds(${JSON.stringify(request.pr_url)}),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.deepEqual(
    result.persisted.reviewer_comment_receipts
      .map(
        (receipt: ReviewerCommentReceipt) =>
          `${receipt.surface}:${receipt.comment_id}`
      )
      .sort(),
    ["issue:800", "review_comment:700"]
  );
  for (const receipt of result.persisted
    .reviewer_comment_receipts as ReviewerCommentReceipt[]) {
    assert.equal(receipt.action_token, undefined);
    assert.equal(receipt.author_login, "me");
  }
  // Only the participant's reply remains as conversation, and the hash carries
  // no trace of the reviewer's own comments or their wrapping review.
  assert.deepEqual(result.submitted, [801]);
  assert.equal(
    result.stateHash,
    createHash("sha256")
      .update("abc123|[]|[801]|[]|")
      .digest("hex")
      .slice(0, 16)
  );
});

function seedTier1Review(request: ReviewRequest): string {
  return `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        head_sha: "new-head",
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "old-head",
        summary_diff_hash: "diff-1",
        effective_diff_hash: "diff-2",
        effective_diff_head_sha: "new-head",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: "needs_author_changes",
      });
  `;
}

const TIER1_CONFIG = {
  review_runtime: "claude" as const,
  reviewer_tiers: {
    tier1: { runtime: "claude" as const, model: "claude-cheap", effort: "low" as const },
  },
};

function runTier1Round(
  prefix: string,
  result: string,
  extraAssertions: string = "",
  claudeExtra: Record<string, unknown> = {}
) {
  const workspace = setupRunnerWorkspace(prefix, TIER1_CONFIG);
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-tier1-session",
        result,
        is_error: Boolean(claudeExtra.exitCode),
      }),
      ...claudeExtra,
    },
  });
  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  return runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      ${seedTier1Review(request)}
      await summarizePR(
        ${JSON.stringify(request)},
        { round: "review", tier: 1, diff_hash: "diff-2" }
      );
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        args,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
      ${extraAssertions}
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );
}

test("a verified tier-1 round hands the same diff to a tier-2 pass", () => {
  const result = runTier1Round(
    "review-runner-tier1-verified-",
    "Checked both findings.\n\n## Agent Status\nAgent status: `fixes_verified`"
  );

  assert.ok(result.args.args.includes("claude-cheap"));
  assert.match(result.args.args.join("\n"), /verification round/i);
  // Tier 1 reviewed nothing, so the stored review is untouched.
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
  assert.equal(result.persisted.summary_diff_hash, "diff-1");
  // ...but this diff is covered, so the same diff is not verified twice.
  assert.equal(result.persisted.last_round_diff_hash, "diff-2");
  assert.equal(result.persisted.pending_tier2_reason, "fixes_verified");
  // No terminal verdict comes out of tier 1.
  assert.equal(result.persisted.agent_review_status, undefined);
  assert.equal(result.persisted.error, undefined);
  assert.equal(result.persisted.session_profile.tier, 1);
});

test("a failed fix claim from tier 1 is an actionable verdict", () => {
  const result = runTier1Round(
    "review-runner-tier1-failed-",
    [
      "The second finding still reproduces.",
      "## Agent Status",
      "Agent status: `needs_author_changes`",
    ].join("\n")
  );

  assert.equal(
    result.persisted.agent_review_status,
    "needs_author_changes"
  );
  assert.equal(result.persisted.last_round_diff_hash, "diff-2");
  // Nothing is queued for tier 2: the author owes a change first.
  assert.equal(result.persisted.pending_tier2_reason, undefined);
  assert.equal(result.persisted.summary_diff_hash, "diff-1");
});

test("an unrecognized tier-1 status escalates instead of erroring", () => {
  const result = runTier1Round(
    "review-runner-tier1-unparseable-",
    "Agent status: ready_for_human_approval"
  );

  assert.equal(result.persisted.pending_tier2_reason, "escalate");
  assert.equal(result.persisted.agent_review_status, undefined);
  // Never the error-retry path: that would re-run the cheap tier.
  assert.equal(result.persisted.error, undefined);
});

test("a tier-1 round that fails to run escalates to tier 2", () => {
  const workspace = setupRunnerWorkspace(
    "review-runner-tier1-crash-",
    TIER1_CONFIG
  );
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: { stdout: "not json", exitCode: 1, stderr: "claude exploded" },
  });
  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      ${seedTier1Review(request)}
      await summarizePR(
        ${JSON.stringify(request)},
        { round: "review", tier: 1, diff_hash: "diff-2" }
      );
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.persisted.pending_tier2_reason, "escalate");
  assert.equal(result.persisted.error, undefined);
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
});

test("a tier-1 request runs tier 2 while tiering is disabled", () => {
  const workspace = setupRunnerWorkspace("review-runner-tier1-disabled-", {
    review_runtime: "claude",
    review_model: "claude-full",
  });
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-full-session",
        result:
          "## Summary\nFull review.\n\n## Agent Status\nAgent status: needs_author_changes",
        is_error: false,
      }),
    },
  });
  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      ${seedTier1Review(request)}
      await summarizePR(
        ${JSON.stringify(request)},
        { round: "review", tier: 1, diff_hash: "diff-2" }
      );
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        args,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
    }
  );

  // A full review round, byte for byte: the standing summary is replaced and no
  // tier is recorded.
  assert.ok(result.args.args.includes("claude-full"));
  assert.match(result.args.args.join("\n"), /Cortex City review protocol/);
  assert.match(result.persisted.summary, /^## Summary\nFull review\./);
  assert.equal(result.persisted.summary_diff_hash, "diff-2");
  assert.equal(result.persisted.pending_tier2_reason, undefined);
  assert.equal(result.persisted.agent_review_status, "needs_author_changes");
  assert.equal(result.persisted.session_profile.tier, undefined);
});

test("buildReviewReplyPrompt promises the decision event only off the cheap tier", () => {
  const args = [
    baseConfig({ review_learning_enabled: false }),
    sampleRequest(),
    undefined,
  ] as const;

  const full = buildReviewReplyPrompt(...args, false);
  assert.match(
    full,
    /Cortex City creates exactly one top-level comment from that section/
  );
  assert.doesNotMatch(full, /cheap verification configuration/i);

  const cheap = buildReviewReplyPrompt(...args, true);
  assert.match(cheap, /runs on the cheap verification configuration/i);
  assert.match(cheap, /hands anything material to a full review round/i);
  assert.doesNotMatch(
    cheap,
    /Cortex City creates exactly one top-level comment from that section/
  );
});

test("a reply round answers conversation without touching the stored review", () => {
  const workspace = setupRunnerWorkspace("review-runner-reply-round-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-reply-session",
        result:
          "Answered the thread; my earlier request was out of scope.\n\n## Agent Status\nAgent status: `replied`",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "abc123",
        summary_diff_hash: "diff-1",
        effective_diff_hash: "diff-1",
        effective_diff_head_sha: "abc123",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: "needs_author_changes",
        last_conversation_seen_at: "2026-05-01T00:00:00.000Z",
      });
      const summary = await summarizePR(
        ${JSON.stringify(request)},
        { runtime: "claude", round: "reply", diff_hash: "diff-1" }
      );
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        summary,
        args,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  const prompt = result.args.args.join("\n");
  assert.match(prompt, /Cortex City reply round protocol/);
  assert.doesNotMatch(prompt, /Cortex City review protocol/);
  // The reply round leaves the review of the code exactly as it was.
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
  assert.equal(result.persisted.generated_at, "2026-05-01T00:10:00.000Z");
  assert.equal(result.persisted.summary_diff_hash, "diff-1");
  assert.equal(result.persisted.agent_review_status, "needs_author_changes");
  assert.equal(result.persisted.error, undefined);
  // ...and clears the trigger that scheduled it.
  assert.ok(
    new Date(result.persisted.last_conversation_seen_at).getTime() >
      Date.parse("2026-05-01T00:00:00.000Z")
  );
});

// A reply round on the cheap tier: same round, different escalation contract.
function runCheapReplyRound(
  prefix: string,
  claudeStdout: Record<string, unknown>,
  claudeExtra: Record<string, unknown> = {},
  standingVerdict = "needs_author_changes"
) {
  const workspace = setupRunnerWorkspace(prefix, TIER1_CONFIG);
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        nextIssueCommentId: 9200,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: { stdout: JSON.stringify(claudeStdout), ...claudeExtra },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  return runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "abc123",
        summary_diff_hash: "diff-1",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: ${JSON.stringify(standingVerdict)},
        last_conversation_seen_at: "2026-05-01T00:00:00.000Z",
      });
      await summarizePR(
        ${JSON.stringify(request)},
        { round: "reply", tier: 1, diff_hash: "diff-1" }
      );
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        ghState: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(ghStateFile)}, "utf-8")),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );
}

test("a cheap reply round escalates instead of raising the decision itself", () => {
  const material = runCheapReplyRound("review-runner-cheap-reply-material-", {
    session_id: "claude-cheap-reply",
    result: [
      "Replied on the thread.",
      "## Agent Status",
      "Agent status: `needs_human_decision`",
      "## Human Decision",
      "We disagree on whether the retry belongs in this PR.",
    ].join("\n"),
    is_error: false,
  });

  // No terminal verdict and no durable decision comment from the cheap tier:
  // the queued tier-2 round owns both.
  assert.equal(material.persisted.pending_tier2_reason, "escalate");
  assert.equal(
    material.persisted.agent_review_status,
    "needs_author_changes"
  );
  assert.equal(
    material.ghState.prs["acme/widget#1"].issueComments.length,
    0
  );
  assert.equal(material.persisted.error, undefined);
  assert.equal(material.persisted.summary, "## Summary\nThe standing review.");

  // An unrecognized status escalates rather than recording an error, which would
  // only re-run the cheap tier.
  const unparseable = runCheapReplyRound(
    "review-runner-cheap-reply-unparseable-",
    { session_id: "s", result: "I replied to everyone.", is_error: false }
  );
  assert.equal(unparseable.persisted.pending_tier2_reason, "escalate");
  assert.equal(unparseable.persisted.error, undefined);

  // So does a run that failed outright.
  const crashed = runCheapReplyRound(
    "review-runner-cheap-reply-crash-",
    { result: "" },
    { exitCode: 1, stderr: "claude exploded" }
  );
  assert.equal(crashed.persisted.pending_tier2_reason, "escalate");
  assert.equal(crashed.persisted.error, undefined);

  // And a run that failed while its partial output still carried a parseable
  // `replied` line. The status line is not evidence the round finished, so it
  // escalates and leaves the conversation owed.
  const failedButParseable = runCheapReplyRound(
    "review-runner-cheap-reply-failed-parseable-",
    {
      session_id: "s",
      result: "Answered.\n\n## Agent Status\nAgent status: `replied`",
      is_error: true,
    },
    { exitCode: 1, stderr: "claude timed out" }
  );
  assert.equal(failedButParseable.persisted.pending_tier2_reason, "escalate");
  assert.equal(failedButParseable.persisted.error, undefined);
  assert.equal(
    failedButParseable.persisted.last_conversation_seen_at,
    "2026-05-01T00:00:00.000Z"
  );

  // `replied` leaves the standing verdict alone and queues nothing.
  const replied = runCheapReplyRound("review-runner-cheap-reply-done-", {
    session_id: "s",
    result: "Answered.\n\n## Agent Status\nAgent status: `replied`",
    is_error: false,
  });
  assert.equal(replied.persisted.pending_tier2_reason, undefined);
  assert.equal(
    replied.persisted.agent_review_status,
    "needs_author_changes"
  );
  assert.ok(
    new Date(replied.persisted.last_conversation_seen_at).getTime() >
      Date.parse("2026-05-01T00:00:00.000Z")
  );
});

test("a reply round that settles the standing verdict hands the diff to tier 2", () => {
  // The regression this guards: the standing verdict outlived the conversation
  // that settled it. `replied` leaves the verdict alone by design, so a reply
  // round agreeing the finding was fixed left `needs_author_changes` standing,
  // and scheduling — a covered diff, no unanswered conversation — ran nothing
  // else. `Ready for manual approval` then never got posted, because only a
  // tier-2 round can reach `ready_for_human_approval`.
  const resolved = runCheapReplyRound("review-runner-cheap-reply-resolved-", {
    session_id: "s",
    result: [
      "The author landed the fix I asked for, so my request no longer applies.",
      "## Agent Status",
      "Agent status: `resolved`",
    ].join("\n"),
    is_error: false,
  });

  assert.equal(
    resolved.persisted.pending_tier2_reason,
    "conversation_resolved"
  );
  // The reply round does not get to replace the verdict itself; the queued
  // tier-2 round does.
  assert.equal(
    resolved.persisted.agent_review_status,
    "needs_author_changes"
  );
  assert.equal(resolved.persisted.review_state, "re_reviewing");
  assert.equal(resolved.persisted.error, undefined);
  assert.equal(resolved.persisted.summary, "## Summary\nThe standing review.");
  // The hand-off is recorded as a resolution, not as a cheap-tier escalation.
  assert.equal(
    resolved.ghState.prs["acme/widget#1"].issueComments.length,
    0
  );

  // A verdict that already reads `ready_for_human_approval` has nothing to
  // re-derive, so a `resolved` reply against one queues no round.
  const alreadyReady = runCheapReplyRound(
    "review-runner-cheap-reply-resolved-ready-",
    {
      session_id: "s",
      result: "Nothing left to do here.\n\n## Agent Status\nAgent status: `resolved`",
      is_error: false,
    },
    {},
    "ready_for_human_approval"
  );
  assert.equal(alreadyReady.persisted.pending_tier2_reason, undefined);
  assert.equal(
    alreadyReady.persisted.agent_review_status,
    "ready_for_human_approval"
  );
});

test("a tier-2 reply round hands a settled verdict on without tiering", () => {
  // With tiering off there is no cheap-tier escalation to carry the hand-off, so
  // the `resolved` status is the only thing that queues the round which replaces
  // the verdict.
  const workspace = setupRunnerWorkspace("review-runner-reply-resolved-full-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const argsFile = path.join(workspace, "agent-args.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-reply-session",
        result:
          "The decision I raised is settled.\n\n## Agent Status\nAgent status: `resolved`",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "abc123",
        summary_diff_hash: "diff-1",
        effective_diff_hash: "diff-1",
        effective_diff_head_sha: "abc123",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: "needs_human_decision",
        last_conversation_seen_at: "2026-05-01T00:00:00.000Z",
      });
      await summarizePR(
        ${JSON.stringify(request)},
        { runtime: "claude", round: "reply", diff_hash: "diff-1" }
      );
      const args = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8"));
      console.log(JSON.stringify({
        args,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_AGENT_ARGS_FILE: argsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  // The round is told which verdict is standing, so `resolved` is usable.
  assert.match(
    result.args.args.join("\n"),
    /Standing verdict from your last review round: `needs_human_decision`/
  );
  assert.equal(
    result.persisted.pending_tier2_reason,
    "conversation_resolved"
  );
  assert.equal(result.persisted.agent_review_status, "needs_human_decision");
  assert.equal(result.persisted.error, undefined);
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
});

test("a failed tier-1 run escalates even when its output parses", () => {
  const result = runTier1Round(
    "review-runner-tier1-failed-parseable-",
    "Checked both findings.\n\n## Agent Status\nAgent status: `fixes_verified`",
    "",
    { exitCode: 1, stderr: "claude timed out" }
  );

  // A parseable status line from a run that did not finish is not a verification
  // result, so it escalates rather than being taken at its word.
  assert.equal(result.persisted.pending_tier2_reason, "escalate");
  assert.equal(result.persisted.agent_review_status, undefined);
  assert.equal(result.persisted.error, undefined);
});

test("a tier-1 round covers the head when the diff cannot be identified", () => {
  const workspace = setupRunnerWorkspace(
    "review-runner-tier1-no-diff-",
    TIER1_CONFIG
  );
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-tier1-no-diff",
        result:
          "The second finding still reproduces.\n\n## Agent Status\nAgent status: `needs_author_changes`",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
      `import { summaryCoversHead } from ${JSON.stringify(moduleUrl("src/lib/review-status.ts"))};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        head_sha: "new-head",
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:10:00.000Z",
      });
      // No diff_hash: GitHub could not identify this PR's effective diff.
      await summarizePR(
        ${JSON.stringify(request)},
        { round: "review", tier: 1 }
      );
      const persisted = readReviewSummaryMap()[${JSON.stringify(request.pr_url)}];
      console.log(JSON.stringify({
        persisted,
        coversHead: summaryCoversHead(persisted),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  // Without a head watermark the verification result would cover nothing: the
  // builder wake would be skipped, the UI would stay `re_reviewing`, and the
  // same round would be scheduled again every poll.
  assert.equal(result.persisted.last_round_diff_hash, undefined);
  assert.equal(result.persisted.last_round_head_sha, "new-head");
  assert.equal(result.coversHead, true);
  assert.equal(
    result.persisted.agent_review_status,
    "needs_author_changes"
  );
  assert.equal(result.persisted.summary_head_sha, "old-head");
});

test("a reply round escalates a material discovery to a human decision", () => {
  const workspace = setupRunnerWorkspace("review-runner-reply-escalate-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        nextIssueCommentId: 9100,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-reply-escalation",
        result: [
          "Replied on the thread.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "The author and I disagree on whether the retry belongs in this PR.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "abc123",
        summary_diff_hash: "diff-1",
        generated_at: "2026-05-01T00:10:00.000Z",
      });
      await summarizePR(
        ${JSON.stringify(request)},
        { runtime: "claude", round: "reply", diff_hash: "diff-1" }
      );
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        ghState: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(ghStateFile)}, "utf-8")),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(
    result.persisted.agent_review_status,
    "needs_human_decision"
  );
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
  const posted = result.ghState.prs["acme/widget#1"].issueComments;
  assert.equal(posted.length, 1);
  assert.match(
    posted[0].body,
    /Human decision needed:[^]*retry belongs in this PR/
  );
  assert.deepEqual(
    result.persisted.reviewer_comment_receipts.map(
      (receipt: ReviewerCommentReceipt) => receipt.comment_id
    ),
    [9100]
  );
});

test("a reply round with no recognized status fails toward a review round", () => {
  const workspace = setupRunnerWorkspace("review-runner-reply-unparseable-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-reply-unparseable",
        result: "I replied to everyone.",
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "## Summary\\nThe standing review.",
        summary_head_sha: "abc123",
        summary_diff_hash: "diff-1",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: "needs_author_changes",
        last_conversation_seen_at: "2026-05-01T00:00:00.000Z",
      });
      await summarizePR(
        ${JSON.stringify(request)},
        { runtime: "claude", round: "reply", diff_hash: "diff-1" }
      );
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.match(result.persisted.error, /did not report a recognized status/);
  assert.equal(result.persisted.summary, "## Summary\nThe standing review.");
  assert.equal(result.persisted.agent_review_status, "needs_author_changes");
  // The trigger is not cleared, so the conversation is still owed an answer.
  assert.equal(
    result.persisted.last_conversation_seen_at,
    "2026-05-01T00:00:00.000Z"
  );
});

test("summarizePR posts and persists an application-owned human-decision comment", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-comment-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        nextIssueCommentId: 8123,
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-decision-session",
        result: [
          "## Summary",
          "A human choice remains.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "Human decision comment ID: 999",
          "## Human Decision",
          "Choose A or B before merging.",
        ].join("\n"),
        is_error: false,
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
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.summary.agent_review_status, "needs_human_decision");
  assert.equal(result.summary.reviewer_comment_receipts.length, 1);
  assert.equal(result.persisted.reviewer_comment_receipts.length, 1);
  assert.equal(result.persisted.reviewer_comment_receipts[0].comment_id, 8123);
  assert.equal(result.persisted.reviewer_comment_receipts[0].author_login, "me");
  assert.match(
    result.persisted.reviewer_comment_receipts[0].body_sha256,
    /^[0-9a-f]{64}$/
  );
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  assert.equal(ghState.prs["acme/widget#1"].issueComments.length, 1);
  assert.equal(
    ghState.prs["acme/widget#1"].issueComments[0].user.login,
    "me"
  );
  assert.match(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    /^\*\*🤖\[Cortex City Reviewer\]\*\* \*\*Human decision needed:\*\* Choose A or B before merging\./
  );
  assert.match(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    /<!-- cortex-city-review-decision:[0-9a-f-]{36} -->$/
  );
});

test("summarizePR appends a revised decision without editing the prior event", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-update-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const ghCallsFile = path.join(workspace, "gh-calls.jsonl");
  const activeToken = "11111111-1111-4111-8111-111111111111";
  const priorDelivery = reviewerDelivery(
    activeToken,
    "Choose the legacy path.",
    "old-head"
  );
  const priorReceipt = reviewerReceipt(priorDelivery, 8122);
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        headRefOid: "new-head",
        issueComments: [
          {
            id: 8122,
            body: priorDelivery.body,
            user: { login: "me" },
          },
        ],
        nextIssueCommentId: 9000,
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-decision-update-session",
        result: [
          "## Summary",
          "The new head still needs a decision.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose the new implementation path.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ head_sha: "new-head" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        head_sha: "old-head",
        summary: "The old head needs a decision.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:10:00.000Z",
        reviewer_comment_receipts: ${JSON.stringify([priorReceipt])},
      });
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_CALLS_FILE: ghCallsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.persisted.agent_review_status, "needs_human_decision");
  assert.deepEqual(
    result.persisted.reviewer_comment_receipts.map(
      (receipt: ReviewerCommentReceipt) => receipt.comment_id
    ),
    [8122, 9000]
  );
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  const comments = ghState.prs["acme/widget#1"].issueComments;
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, priorDelivery.body);
  assert.equal(comments[1].id, 9000);
  assert.match(comments[1].body, /Choose the new implementation path\./);
  assert.doesNotMatch(comments[1].body, new RegExp(activeToken));
  const calls = readFileSync(ghCallsFile, "utf-8");
  assert.doesNotMatch(calls, /"PATCH"|"DELETE"/);
});

test("summarizePR rejects a clean inbound verdict approved at another SHA", () => {
  const workspace = setupRunnerWorkspace("review-runner-approval-missing-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    viewerLogin: "me",
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [],
        reviews: [approvedReview("older-head")],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-missing-approval-session",
        result: [
          "## Summary",
          "No blocking issues found.",
          "## Agent Status",
          "Agent status: `ready_for_human_approval`",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "inbound" });
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
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.match(result.persisted.error, /reviewed commit/i);
  assert.equal(result.persisted.agent_review_status, undefined);
  assert.equal(result.persisted.summary_head_sha, undefined);
  assert.equal(result.persisted.review_state, "generation_failed");
});

test("summarizePR posts a manual-approval handoff for a clean self-authored review", () => {
  const workspace = setupRunnerWorkspace("review-runner-self-approval-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [],
        nextIssueCommentId: 8124,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-self-approval-session",
        result: [
          "## Summary",
          "No blocking issues found.",
          "## Agent Status",
          "Agent status: `ready_for_human_approval`",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({
    source: "inbound",
    label_only: true,
    self_authored: true,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      const submittedIds = await getSubmittedCommentIds(${JSON.stringify(request.pr_url)});
      console.log(JSON.stringify({
        summary,
        submittedIds,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.persisted.agent_review_status, "ready_for_human_approval");
  assert.equal(result.persisted.reviewer_comment_receipts.length, 1);
  assert.equal(result.persisted.reviewer_comment_receipts[0].comment_id, 8124);
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  assert.match(
    result.persisted.reviewer_comment_receipts[0].action_token,
    /^[0-9a-f-]{36}$/
  );
  assert.deepEqual(result.submittedIds, []);
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  assert.equal(ghState.prs["acme/widget#1"].issueComments.length, 1);
  assert.match(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    /^\*\*🤖\[Cortex City Reviewer\]\*\* \*\*Ready for manual approval:\*\* Cortex City found no blocking issues and would approve this PR, but GitHub does not allow the PR author to approve their own pull request\. Please ask an eligible non-author reviewer to approve it, or make the appropriate manual merge or coordination decision if repository policy permits\./
  );
  assert.match(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    /<!-- cortex-city-review-decision:[0-9a-f-]{36} -->$/
  );
});

test("summarizePR recovers an exact comment posted before a prior save crashed", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-reconcile-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const pendingDelivery = reviewerDelivery(
    pendingToken,
    "Choose A or B before merging."
  );
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        issueComments: [
          {
            id: 8122,
            body: pendingDelivery.body,
            user: { login: "me" },
          },
        ],
        nextIssueCommentId: 9000,
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-reconcile-session",
        result: [
          "## Summary",
          "A human choice remains.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose A or B before merging.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "inbound" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "A previous run did not save its receipt.",
        generated_at: "2026-05-01T00:10:00.000Z",
        pending_reviewer_comment_delivery: ${JSON.stringify(pendingDelivery)},
      });
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.persisted.reviewer_comment_receipts.length, 1);
  assert.equal(result.persisted.reviewer_comment_receipts[0].comment_id, 8122);
  assert.equal(
    result.persisted.reviewer_comment_receipts[0].action_token,
    pendingToken
  );
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  assert.equal(ghState.prs["acme/widget#1"].issueComments.length, 1);
  assert.equal(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    pendingDelivery.body
  );
});

test("summarizePR trusts a verified receipt instead of recreating a deleted event", () => {
  const workspace = setupRunnerWorkspace("review-runner-deleted-receipt-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const ghCallsFile = path.join(workspace, "gh-calls.jsonl");
  const token = "11111111-1111-4111-8111-111111111111";
  const delivery = reviewerDelivery(token, "Choose A or B before merging.");
  const receipt = reviewerReceipt(delivery, 8122);
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        issueComments: [],
        nextIssueCommentId: 9000,
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-deleted-receipt-session",
        result: [
          "## Summary",
          "A human choice remains.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose A or B before merging.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "The prior result was interrupted.",
        generated_at: "2026-05-01T00:10:00.000Z",
        reviewer_comment_receipts: ${JSON.stringify([receipt])},
        pending_reviewer_comment_delivery: ${JSON.stringify(delivery)},
      });
      await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_CALLS_FILE: ghCallsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.deepEqual(result.persisted.reviewer_comment_receipts, [receipt]);
  assert.equal(result.persisted.pending_reviewer_comment_delivery, undefined);
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  assert.deepEqual(ghState.prs["acme/widget#1"].issueComments, []);
  const calls = existsSync(ghCallsFile)
    ? readFileSync(ghCallsFile, "utf-8")
    : "";
  assert.doesNotMatch(calls, /"POST"|"PATCH"|"DELETE"/);
});

test("summarizePR leaves a prior decision event immutable when a later review is clean", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-remove-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const priorDelivery = reviewerDelivery(
    pendingToken,
    "Choose the legacy path."
  );
  const priorReceipt = reviewerReceipt(priorDelivery, 8122);
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [
          {
            id: 8122,
            body: priorDelivery.body,
            user: { login: "me" },
          },
        ],
        reviews: [approvedReview("abc123")],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-clean-rebuild-session",
        result: [
          "## Summary",
          "The rebuilt review is clean.",
          "## Agent Status",
          "Agent status: `ready_for_human_approval`",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "inbound" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "A previous run did not save its receipt.",
        generated_at: "2026-05-01T00:10:00.000Z",
        reviewer_comment_receipts: ${JSON.stringify([priorReceipt])},
      });
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.persisted.agent_review_status, "ready_for_human_approval");
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  assert.deepEqual(result.persisted.reviewer_comment_receipts, [priorReceipt]);
  assert.equal(result.persisted.my_approval_sha, "abc123");
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  assert.equal(ghState.prs["acme/widget#1"].issueComments.length, 1);
  assert.equal(
    ghState.prs["acme/widget#1"].issueComments[0].body,
    priorDelivery.body
  );
});

test("summarizePR never adopts or filters a participant's copied action marker", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-copy-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const ghCallsFile = path.join(workspace, "gh-calls.jsonl");
  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const pendingDelivery = reviewerDelivery(
    pendingToken,
    "Copied participant prompt."
  );
  const copiedBody = pendingDelivery.body;
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [
          { id: 8123, body: copiedBody, user: { login: "participant" } },
        ],
        nextIssueCommentId: 9000,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-copy-session",
        result: [
          "## Summary",
          "A human choice remains.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Copied participant prompt.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({ source: "task", task_id: "task-1" });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "A previous run did not save its clean rebuild.",
        generated_at: "2026-05-01T00:10:00.000Z",
        pending_reviewer_comment_delivery: ${JSON.stringify(pendingDelivery)},
      });
      const submittedBefore = await getSubmittedCommentIds(${JSON.stringify(request.pr_url)});
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      const submittedAfter = await getSubmittedCommentIds(${JSON.stringify(request.pr_url)});
      console.log(JSON.stringify({
        summary,
        submittedBefore,
        submittedAfter,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_CALLS_FILE: ghCallsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.deepEqual(result.submittedBefore, [8123]);
  assert.deepEqual(result.submittedAfter, [8123]);
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  assert.equal(result.persisted.reviewer_comment_receipts.length, 1);
  assert.equal(result.persisted.reviewer_comment_receipts[0].comment_id, 9000);
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  const comments = ghState.prs["acme/widget#1"].issueComments;
  assert.equal(comments.length, 2);
  assert.equal(comments[0].user.login, "participant");
  assert.equal(comments[1].user.login, "me");
  assert.equal(comments[0].body, comments[1].body);
  const calls = readFileSync(ghCallsFile, "utf-8");
  assert.doesNotMatch(calls, /"PATCH"|"DELETE"/);
});

test("summarizePR appends a distinct rebuilt decision after recovering a pending event", () => {
  const workspace = setupRunnerWorkspace("review-runner-decision-replace-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const ghCallsFile = path.join(workspace, "gh-calls.jsonl");
  const priorToken = "11111111-1111-4111-8111-111111111111";
  const priorDelivery = reviewerDelivery(
    priorToken,
    "Choose the old implementation path.",
    "old-head"
  );
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        headRefOid: "new-head",
        issueComments: [
          { id: 8123, body: priorDelivery.body, user: { login: "me" } },
        ],
        nextIssueCommentId: 9000,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-replacement-session",
        result: [
          "## Summary",
          "The new head needs a different human decision.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose the new implementation path.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        head_sha: "old-head",
        summary: "The old head was clean.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:10:00.000Z",
        pending_reviewer_comment_delivery: ${JSON.stringify(priorDelivery)},
      });
      const submittedBefore = await getSubmittedCommentIds(${JSON.stringify(request.pr_url)});
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      const submittedAfter = await getSubmittedCommentIds(${JSON.stringify(request.pr_url)});
      console.log(JSON.stringify({
        summary,
        submittedBefore,
        submittedAfter,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_CALLS_FILE: ghCallsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  // The prior decision comment is the reviewer's own, so it never counts as
  // conversation — before the run (matched by prefix and author) or after it
  // (matched by its receipt).
  assert.deepEqual(result.submittedBefore, []);
  assert.deepEqual(result.submittedAfter, []);
  assert.equal(result.persisted.summary_head_sha, "new-head");
  assert.equal(result.persisted.agent_review_status, "needs_human_decision");
  assert.equal(
    result.persisted.pending_reviewer_comment_delivery,
    undefined
  );
  assert.deepEqual(
    result.persisted.reviewer_comment_receipts.map(
      (receipt: ReviewerCommentReceipt) => receipt.comment_id
    ),
    [8123, 9000]
  );
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  const comments = ghState.prs["acme/widget#1"].issueComments;
  assert.equal(comments[0].body, priorDelivery.body);
  assert.equal(comments.length, 2);
  assert.match(
    comments[1].body,
    /^\*\*🤖\[Cortex City Reviewer\]\*\* \*\*Human decision needed:\*\* Choose the new implementation path\./
  );
  assert.doesNotMatch(comments[1].body, new RegExp(priorToken));
  assert.match(
    comments[1].body,
    /<!-- cortex-city-review-decision:[0-9a-f-]{36} -->$/
  );
  const calls = readFileSync(ghCallsFile, "utf-8");
  assert.doesNotMatch(calls, /"PATCH"|"DELETE"/);
});

test("summarizePR cancels an undelivered stale action before posting the current decision", () => {
  const workspace = setupRunnerWorkspace("review-runner-stale-decision-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  const ghCallsFile = path.join(workspace, "gh-calls.jsonl");
  const priorToken = "11111111-1111-4111-8111-111111111111";
  const priorDelivery = reviewerDelivery(
    priorToken,
    "Choose the stale implementation path.",
    "old-head"
  );
  writeJson(ghStateFile, {
    prs: {
      "acme/widget#1": {
        state: "open",
        merged: false,
        headRefOid: "new-head",
        issueComments: [],
        nextIssueCommentId: 9000,
        reviews: [],
        comments: [],
        checks: [],
      },
    },
  });
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-current-decision-session",
        result: [
          "## Summary",
          "Only the new head was reviewed.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose the current implementation path.",
        ].join("\n"),
        is_error: false,
      }),
    },
  });

  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    head_sha: "new-head",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        head_sha: "old-head",
        summary: "The old head was reviewed.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:10:00.000Z",
        pending_reviewer_comment_delivery: ${JSON.stringify(priorDelivery)},
      });
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_CALLS_FILE: ghCallsFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.persisted.summary_head_sha, "new-head");
  assert.equal(result.persisted.pending_reviewer_comment_delivery, undefined);
  assert.equal(
    result.persisted.reviewer_comment_cancellations[0].action_token,
    priorToken
  );
  assert.equal(
    result.persisted.reviewer_comment_cancellations[0].reason,
    "head_changed"
  );
  assert.deepEqual(
    result.persisted.reviewer_comment_receipts.map(
      (receipt: ReviewerCommentReceipt) => receipt.comment_id
    ),
    [9000]
  );
  const ghState = JSON.parse(readFileSync(ghStateFile, "utf-8"));
  const comments = ghState.prs["acme/widget#1"].issueComments;
  assert.equal(comments.length, 1);
  assert.doesNotMatch(comments[0].body, new RegExp(priorToken));
  assert.match(comments[0].body, /Choose the current implementation path\./);
  const calls = readFileSync(ghCallsFile, "utf-8");
  assert.doesNotMatch(calls, /"PATCH"|"DELETE"/);
});

test("spawnReviewSummary preserves retro and cancellation state through claim and completion", () => {
  const workspace = setupRunnerWorkspace("review-runner-retro-preserve-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const cancellation = {
    action_token: "44444444-4444-4444-8444-444444444444",
    reason: "head_changed",
    expected_head_sha: "old-head",
    observed_head_sha: "abc123",
    observed_pr_state: "open",
    body_sha256: "d".repeat(64),
    canceled_at: "2026-05-01T00:15:00.000Z",
  };
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-retro",
        result: "## Summary\nUpdated.",
        is_error: false,
      }),
      sleepMs: 2_000,
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
          reviewer_comment_cancellations: [cancellation],
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
  assert.equal(typeof result.during.current_run_pid, "number");
  assert.deepEqual(result.during.reviewer_comment_cancellations, [cancellation]);
  assert.equal(result.summary.summary, "## Summary\nUpdated.");
  assert.equal(result.persisted.retro_status, "done");
  assert.equal(result.persisted.retro_done_at, "2026-05-01T00:20:00.000Z");
  assert.equal(result.persisted.retro_run_pid, undefined);
  assert.equal(result.persisted.retro_error, undefined);
  assert.deepEqual(
    result.persisted.reviewer_comment_cancellations,
    [cancellation]
  );
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

test("spawnReviewSummary publishes nothing when the stack slice scope changes mid-run at the same HEAD", () => {
  const workspace = setupRunnerWorkspace("review-runner-slice-race-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
  // The verdict would normally publish a reviewer-owned human-decision
  // comment. A slice-scope change lands while the run is in flight, at an
  // unchanged HEAD, so the stale result must neither post nor persist.
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "slice-race-session",
        result:
          "## Summary\nReviewed under the old slice scope.\n\n## Agent Status\nAgent status: needs_human_decision",
        is_error: false,
      }),
      // The scope change is written while this run is in flight, so the run has
      // to outlast a cross-process store write. 100ms lost that race on a loaded
      // CI runner and failed the review with the stale result instead of
      // discarding it.
      sleepMs: 2_000,
    },
  });
  writeJson(ghStateFile, {
    viewerLogin: "me",
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [],
        reviews: [],
      },
    },
  });

  const request = sampleRequest({
    source: "task",
    task_id: "task-1",
    task_title: "Stacked task",
    task_description: "Build it in slices",
    task_stack_position: 2,
    task_stack_size: 3,
    task_pr_scope: "Original slice scope",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { readFileSync } from "node:fs";`,
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { patchReviewSummary, readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const spawned = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" }
      );
      await patchReviewSummary(${JSON.stringify(request.pr_url)}, {
        task_pr_scope: "Updated slice scope",
        updated_at: "2026-05-01T00:30:00.000Z",
      });
      const summary = await spawned.done;
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
        ghState: JSON.parse(readFileSync(${JSON.stringify(ghStateFile)}, "utf-8")),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  // The stale run result is discarded and the review is queued for a rerun
  // under the updated slice scope.
  assert.equal(result.persisted.task_pr_scope, "Updated slice scope");
  assert.equal(result.persisted.summary, "");
  assert.equal(result.persisted.summary_head_sha, undefined);
  assert.equal(result.persisted.agent_review_status, undefined);
  assert.equal(result.persisted.review_status, "pending_summary");
  assert.equal(result.persisted.review_state, "queued");
  // No reviewer-owned comment was posted or left pending.
  assert.equal(result.persisted.pending_reviewer_comment_delivery, undefined);
  assert.equal(result.persisted.reviewer_comment_receipts, undefined);
  assert.deepEqual(
    result.ghState.prs["acme/widget#1"].issueComments ?? [],
    []
  );
});

test("spawnReviewSummary keeps a mid-flight change request over the run's verdict", () => {
  const workspace = setupRunnerWorkspace("review-runner-changes-preserve-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const ghStateFile = path.join(workspace, "gh-state.json");
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
  writeJson(ghStateFile, {
    viewerLogin: "me",
    prs: {
      "acme/widget#1": {
        headRefOid: "abc123",
        issueComments: [],
        reviews: [approvedReview("abc123")],
      },
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
      FAKE_GH_STATE_FILE: ghStateFile,
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

// The Q&A resume pointer must identify the session that produced the persisted
// summary. Both of these used to leave it aimed somewhere else.
function runSessionPointerCase(
  prefix: string,
  claudeStdout: Record<string, unknown>,
  claudeExtra: Record<string, unknown> = {}
) {
  const workspace = setupRunnerWorkspace(prefix);
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: { stdout: JSON.stringify(claudeStdout), ...claudeExtra },
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
        model: "claude-sonnet-4-6",
        session_profile: {
          runtime: "claude",
          effort: "max",
          model: "claude-sonnet-4-6",
        },
        session_id: "claude-session-1",
      },
    })
  );

  return runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );
}

test("a saved summary never inherits the previous run's session pointer", () => {
  // A fresh run that reported no session id: the new summary is published, so
  // the stale pointer must be dropped rather than aimed at the old head.
  const result = runSessionPointerCase("review-runner-session-pointer-none-", {
    result: "## Summary\nFresh review of the new head.",
    is_error: false,
  });

  assert.equal(result.persisted.summary_head_sha, "new-head");
  assert.match(result.persisted.summary, /^## Summary\nFresh review/);
  assert.equal(result.persisted.session_id, undefined);
});

test("a failed run keeps the pointer to the summary it did not replace", () => {
  // A failed fresh run that did report a session id: the old summary survives,
  // so the pointer must stay with it instead of moving to the failed session.
  const result = runSessionPointerCase(
    "review-runner-session-pointer-failed-",
    {
      session_id: "failed-fresh-session",
      result: "",
      is_error: true,
    },
    { exitCode: 1, stderr: "claude failed" }
  );

  assert.equal(result.persisted.summary, "old summary");
  assert.equal(result.persisted.summary_head_sha, "old-head");
  assert.ok(result.persisted.error);
  assert.equal(result.persisted.session_id, "claude-session-1");
});

test("summarizePR starts a fresh session for a scheduled follow-up and seeds the stored summary", () => {
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

  assert.equal(result.args.args.includes("--resume"), false);
  assert.equal(result.args.args.includes("claude-session-1"), false);
  assert.match(result.args.args.join("\n"), /follow-up round in verification mode/i);
  assert.match(
    result.args.args.join("\n"),
    /Verify each enumerated finding at the current head/i
  );
  assert.match(result.args.args.join("\n"), /This session is fresh/i);
  assert.match(
    result.args.args.join("\n"),
    /<previous_review>\nold summary\n<\/previous_review>/
  );
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
  const reviewRoot = path.join(workspace, "review-scratch");
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
      CORTEX_REVIEW_WORKSPACE_ROOT: reviewRoot,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.match(result.summary.error, /Run timed out after 25ms/);
  assert.equal(result.summary.summary, "");
  assert.equal(result.summary.current_run_pid, undefined);
  assert.match(result.persisted.error, /Run timed out after 25ms/);
  assert.equal(readdirSync(reviewRoot).length, 1);
});

test("summarizePR preserves cancellation state on a low-disk preflight failure", () => {
  const workspace = setupRunnerWorkspace("review-runner-disk-preflight-");
  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/301",
    pr_number: 301,
  });
  const cancellation = {
    action_token: "44444444-4444-4444-8444-444444444444",
    reason: "pr_not_open",
    expected_head_sha: "abc123",
    observed_head_sha: "abc123",
    observed_pr_state: "closed",
    body_sha256: "e".repeat(64),
    canceled_at: "2026-05-01T00:15:00.000Z",
  };
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await upsertReviewSummary({
        ...${JSON.stringify(request)},
        summary: "",
        generated_at: "",
        reviewer_comment_cancellations: ${JSON.stringify([cancellation])},
      });
      let thrown;
      try {
        await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({
        thrown,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      CORTEX_REVIEW_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER),
    }
  );

  assert.match(result.thrown, /Low disk space before launching claude review runtime/);
  assert.equal(result.persisted.error, result.thrown);
  assert.equal(typeof result.persisted.error_at, "string");
  assert.equal(result.persisted.summary, "");
  assert.equal(result.persisted.current_run_pid, undefined);
  assert.deepEqual(
    result.persisted.reviewer_comment_cancellations,
    [cancellation]
  );
});

test("spawnRuntime terminates a running reviewer when it crosses the reserve", async () => {
  const workspace = setupRunnerWorkspace("review-runner-disk-monitor-");
  const descendantMarker = path.join(workspace, "descendant-survived");
  const descendantScript = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(descendantMarker)}, "alive"), 400)`;
  const fakeClaude = path.join(workspace, "bin", "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const { spawn } = require("child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`
  );
  chmodSync(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = prependBinToPath(workspace).PATH;
  try {
    let checks = 0;
    const spawned = spawnRuntime(
      "claude",
      "review this PR",
      { runtime: "claude" },
      undefined,
      5_000,
      {
        targetPath: workspace,
        minFreeBytes: 15 * 1024 ** 3,
        checkIntervalMs: 100,
        readStatus: (targetPath, minFreeBytes) => ({
          path: targetPath,
          freeBytes: ++checks === 1 ? 20 * 1024 ** 3 : 10 * 1024 ** 3,
          minFreeBytes,
          ok: checks === 1,
        }),
      }
    );
    const output = await spawned.done;

    assert.equal(output.termination_reason, "low_disk");
    assert.match(output.error || "", /Low disk space during the claude review runtime/);
    assert.equal(output.exit_code, null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(descendantMarker), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
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

test("askFollowup returns a storable low-disk failure without launching", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-disk-");
  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/302",
    pr_number: 302,
  });
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify({
      [request.pr_url]: {
        ...request,
        summary: "Prior review",
        summary_head_sha: request.head_sha,
        generated_at: "2026-05-01T00:00:00.000Z",
        runtime: "claude",
      },
    })
  );

  const result = runTsxScript(
    workspace,
    [
      `import { appendFollowup, askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what changed?");
      await appendFollowup(${JSON.stringify(request.pr_url)}, followup);
      console.log(JSON.stringify({
        followup,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      CORTEX_REVIEW_MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER),
    }
  );

  assert.match(result.followup.error, /Low disk space before launching claude review runtime/);
  assert.equal(result.followup.answer, "");
  assert.equal(result.persisted.followups.at(-1).error, result.followup.error);
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
  assert.match(
    argsPayload.args[promptIndex],
    /Use the `gh` CLI for GitHub inspection and comments/
  );
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
