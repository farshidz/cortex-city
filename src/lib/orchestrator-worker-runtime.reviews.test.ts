import test from "node:test";
import assert from "node:assert/strict";

import {
  FINAL_CLASSIFICATION_RETRY_MS,
  PRUNE_AGE_MS,
  REVIEW_ERROR_RETRY_MS,
  pollOnce,
  shouldRetryErroredReview,
  type WorkerRuntimeDeps,
} from "./orchestrator-worker-runtime";
import { deriveReviewState, withReviewStatus } from "./review-status";
import type {
  OrchestratorConfig,
  ReviewRequest,
  ReviewSummary,
  Task,
} from "./types";

interface HarnessOptions {
  config?: Partial<OrchestratorConfig>;
  reviews?: Record<string, ReviewSummary>;
  openReviewRequests?: ReviewRequest[];
  prFinalStates?: Record<string, "merged" | "closed" | null>;
  isPRMergedOrClosed?: (prUrl: string) => Promise<"merged" | "closed" | null>;
  isPidRunning?: (pid: number) => boolean;
  spawnPid?: () => number;
  learnings?: string;
  tasks?: Task[];
  prHeadShas?: Record<string, string>;
  getReviewRequestedPRs?: () => Promise<ReviewRequest[]>;
}

interface Harness {
  deps: WorkerRuntimeDeps;
  reviews: Record<string, ReviewSummary>;
  spawnCalls: ReviewRequest[];
  retroCalls: Array<{ review: ReviewSummary; learningsBefore: string }>;
  deletedPrUrls: string[];
  activeReviewPids: Map<string, number>;
  activeTaskPids: Map<string, number>;
  builderCalls: Array<{ task: Task; mode: string }>;
  stoppedLegacyReviewerPids: number[];
  reviewCompletions: Array<(summary: ReviewSummary) => Promise<void>>;
  tasks: Task[];
}

function makeConfig(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {},
    max_parallel_reviews: 2,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
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

function makeSummary(
  base: ReviewRequest,
  overrides: Partial<ReviewSummary> = {}
): ReviewSummary {
  return withReviewStatus({
    ...base,
    summary: "",
    generated_at: "",
    ...overrides,
  }) as ReviewSummary;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Implement fizzbuzz",
    description: "Build the task-owned behavior",
    plan: "Add focused tests",
    status: "in_review",
    agent: "cortex-city-swe",
    reviewer_agent_enabled: true,
    pr_url: "https://github.com/acme/widget/pull/1",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:10:00.000Z",
    ...overrides,
  };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const reviews: Record<string, ReviewSummary> = { ...(options.reviews || {}) };
  const spawnCalls: ReviewRequest[] = [];
  const retroCalls: Array<{ review: ReviewSummary; learningsBefore: string }> = [];
  const deletedPrUrls: string[] = [];
  const tasks = [...(options.tasks || [])];
  const builderCalls: Array<{ task: Task; mode: string }> = [];
  const stoppedLegacyReviewerPids: number[] = [];
  const reviewCompletions: Array<
    (summary: ReviewSummary) => Promise<void>
  > = [];
  let nextPid = 50_000;
  const spawnPid = options.spawnPid || (() => nextPid++);

  const deps: WorkerRuntimeDeps = {
    deleteTask: async () => {},
    getPRHeadSha: async (prUrl) => options.prHeadShas?.[prUrl] || "",
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs:
      options.getReviewRequestedPRs ||
      (async () => options.openReviewRequests || []),
    getTask: async (id) => tasks.find((task) => task.id === id),
    isPRMergedOrClosed:
      options.isPRMergedOrClosed ||
      (async (prUrl) =>
        options.prFinalStates && prUrl in options.prFinalStates
          ? options.prFinalStates[prUrl]
          : null),
    isPidRunning: options.isPidRunning || (() => true),
    stopLegacyReviewerProcess: (pid) => {
      stoppedLegacyReviewerPids.push(pid);
    },
    logger: { log: () => {}, error: () => {} },
    readConfig: () => makeConfig(options.config),
    readReviewLearnings: () => options.learnings || "",
    readReviewSummaries: () => Object.values(reviews),
    readReviewSummaryMap: () => ({ ...reviews }),
    readTasks: () => tasks,
    removeWorktree: async () => {},
    spawnAgentSession: async (task, mode) => {
      builderCalls.push({ task, mode });
      return { pid: spawnPid(), child: {} as never };
    },
    spawnReviewSummary: async (request, _opts, onComplete) => {
      spawnCalls.push(request);
      const pid = spawnPid();
      reviews[request.pr_url] = {
        ...withReviewStatus({
          ...(reviews[request.pr_url] || makeSummary(request)),
          ...request,
          current_run_pid: pid,
        }),
      };
      if (onComplete) {
        reviewCompletions.push(async (summary) => {
          await onComplete(summary);
        });
      }
      return {
        pid,
        child: {} as never,
        done: new Promise<ReviewSummary>(() => {}),
      };
    },
    spawnReviewRetro: async (review, learningsBefore) => {
      retroCalls.push({ review, learningsBefore });
      const pid = spawnPid();
      reviews[review.pr_url] = {
        ...withReviewStatus({
          ...(reviews[review.pr_url] || review),
          retro_status: "pending",
          retro_run_pid: pid,
        }),
      };
      return {
        pid,
        child: {} as never,
        done: new Promise<void>(() => {}),
      };
    },
    updateTask: async (id, updates) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`Task ${id} not found`);
      tasks[index] = { ...tasks[index], ...updates };
      return tasks[index];
    },
    upsertReviewSummary: async (entry) => {
      reviews[entry.pr_url] = withReviewStatus(entry) as ReviewSummary;
      return reviews[entry.pr_url];
    },
    clearReviewRunIfMatching: async (prUrl, currentRunPid, currentRunId) => {
      const current = reviews[prUrl];
      if (
        !current ||
        current.current_run_pid !== currentRunPid ||
        current.current_run_id !== currentRunId
      ) {
        return undefined;
      }
      reviews[prUrl] = withReviewStatus({
        ...current,
        current_run_pid: undefined,
        current_run_id: undefined,
      }) as ReviewSummary;
      return reviews[prUrl];
    },
    mutateReviewSummary: async (prUrl, updater) => {
      const next = updater(reviews[prUrl]);
      if (!next) return undefined;
      reviews[prUrl] = withReviewStatus(next) as ReviewSummary;
      return reviews[prUrl];
    },
    deleteReviewSummary: async (prUrl) => {
      deletedPrUrls.push(prUrl);
      delete reviews[prUrl];
    },
    deleteReviewSummaryIf: async (prUrl, predicate) => {
      const current = reviews[prUrl];
      if (!current || !predicate(current)) return false;
      deletedPrUrls.push(prUrl);
      delete reviews[prUrl];
      return true;
    },
  };

  return {
    deps,
    reviews,
    spawnCalls,
    retroCalls,
    deletedPrUrls,
    activeReviewPids: new Map(),
    activeTaskPids: new Map(),
    builderCalls,
    stoppedLegacyReviewerPids,
    reviewCompletions,
    tasks,
  };
}

test("pollOnce upserts a brand-new PR and spawns a summary", async () => {
  const pr = makeRequest({ my_last_review_sha: undefined });
  const h = makeHarness({ openReviewRequests: [pr] });
  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored, "review should be persisted");
  assert.equal(stored.head_sha, "abc123");
  assert.equal(stored.my_last_review_sha, undefined);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.activeReviewPids.has(pr.pr_url), true);
});

test("pollOnce skips spawn when cached entry has matching head SHA and a summary", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "previous summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    session_id: "sess-1",
  });
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.reviews[pr.pr_url].summary, "previous summary");
  assert.equal(h.reviews[pr.pr_url].session_id, "sess-1");
});

test("pollOnce preserves review session data and refreshes a changed head SHA", async () => {
  const pr = makeRequest({ head_sha: "newSha" });
  const cached = makeSummary(makeRequest({ head_sha: "oldSha" }), {
    summary: "stale",
    summary_head_sha: "oldSha",
    generated_at: "2026-05-01T00:00:00.000Z",
    session_id: "sess-1",
    agent_review_status: "ready_for_human_approval",
    followups: [
      {
        asked_at: "2026-05-01T00:00:00.000Z",
        question: "?",
        answered_at: "2026-05-01T00:00:01.000Z",
        answer: "!",
        resumed: true,
      },
    ],
  });
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.head_sha, "newSha");
  assert.equal(stored.summary, "stale");
  assert.equal(stored.summary_head_sha, "oldSha");
  assert.equal(stored.generated_at, "2026-05-01T00:00:00.000Z");
  assert.equal(stored.review_status, "summarizing");
  assert.equal(stored.current_run_pid, 50_000);
  assert.equal(stored.session_id, "sess-1");
  assert.equal(stored.agent_review_status, undefined);
  assert.equal(stored.followups?.length, 1);
  assert.equal(h.spawnCalls.length, 1);
});

test("pollOnce refreshes my_last_review_sha when the cached value changes", async () => {
  // PR was previously reviewed at one SHA; the same PR now records a newer
  // review SHA (e.g. I just submitted a review). The worker should write
  // through the new value without spawning a fresh summary because the head
  // SHA is unchanged.
  const pr = makeRequest({
    head_sha: "abc123",
    my_last_review_sha: "abc123",
  });
  const cached = makeSummary(
    makeRequest({ head_sha: "abc123", my_last_review_sha: "old-review-sha" }),
    {
      summary: "previous summary",
      generated_at: "2026-05-01T00:00:00.000Z",
    }
  );
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].my_last_review_sha, "abc123");
  assert.equal(h.spawnCalls.length, 0);
});

test("pollOnce clears a stale verdict when the approval is withdrawn", async () => {
  // I had approved the current head (approval recorded alongside an agent
  // verdict). Then I requested changes / dismissed on GitHub, so this poll
  // reports no approval. The stale verdict must be superseded, otherwise the
  // row would keep showing "Ready to approve" after the approval was withdrawn.
  const pr = makeRequest({
    head_sha: "abc123",
    my_last_review_sha: "abc123",
    my_approval_sha: undefined,
  });
  const cached = makeSummary(
    makeRequest({
      head_sha: "abc123",
      my_last_review_sha: "abc123",
      my_approval_sha: "abc123",
    }),
    {
      summary: "previous summary",
      generated_at: "2026-05-01T00:00:00.000Z",
      agent_review_status: "ready_for_human_approval",
    }
  );
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.my_approval_sha, undefined);
  assert.equal(stored.agent_review_status, undefined);
  assert.equal(h.spawnCalls.length, 0);
});

test("pollOnce threads a GitHub-side change request without a prior approval", async () => {
  // The human requested changes directly on GitHub and had never approved, so
  // my_approval_sha stays undefined (no withdrawal). The worker must still write
  // through my_changes_requested_sha so deriveReviewState can supersede the
  // stale agent verdict with "changes_requested".
  const pr = makeRequest({
    head_sha: "abc123",
    my_last_review_sha: "abc123",
    my_changes_requested_sha: "abc123",
  });
  const cached = makeSummary(
    makeRequest({ head_sha: "abc123", my_last_review_sha: "old-sha" }),
    {
      summary: "previous summary",
      generated_at: "2026-05-01T00:00:00.000Z",
      agent_review_status: "ready_for_human_approval",
    }
  );
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.my_changes_requested_sha, "abc123");
  assert.equal(h.spawnCalls.length, 0);
});

test("pollOnce respects max_parallel_reviews", async () => {
  const a = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
    head_sha: "sha-a",
  });
  const b = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
    head_sha: "sha-b",
  });
  const c = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/3",
    pr_number: 3,
    head_sha: "sha-c",
  });
  const h = makeHarness({
    openReviewRequests: [a, b, c],
    config: { max_parallel_reviews: 1 },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.activeReviewPids.size, 1);
});

test("pollOnce handles a review completion rejected after its owner is cleared", async () => {
  const pr = makeRequest();
  const h = makeHarness({ openReviewRequests: [pr] });
  const spawnReviewSummary = h.deps.spawnReviewSummary;
  let rejectDone!: (reason: unknown) => void;
  h.deps.spawnReviewSummary = async (...args) => {
    const spawned = await spawnReviewSummary(...args);
    return {
      ...spawned,
      done: new Promise<ReviewSummary>((_resolve, reject) => {
        rejectDone = reject;
      }),
    };
  };

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);
  assert.equal(h.activeReviewPids.has(pr.pr_url), true);

  h.reviews[pr.pr_url] = makeSummary(pr);
  rejectDone(new Error("Review run ownership was cleared"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(h.activeReviewPids.has(pr.pr_url), false);
});

test("pollOnce queues a task-owned review with task context when task slots are full", async () => {
  const task = makeTask();
  const unrelatedActiveTask = makeTask({
    id: "active-builder",
    status: "in_progress",
    pr_url: undefined,
    current_run_pid: 41_000,
  });
  const h = makeHarness({
    config: { max_parallel_sessions: 1 },
    tasks: [unrelatedActiveTask, task],
    prHeadShas: { [task.pr_url!]: "task-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.builderCalls.length, 0);
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual(h.spawnCalls[0], {
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
    pr_url: task.pr_url,
    pr_number: 1,
    repo_slug: "acme/widget",
    title: task.title,
    author: "",
    head_sha: "task-head",
    created_at: task.created_at,
    updated_at: task.updated_at,
  });
});

test("pollOnce excludes task-owned reviews while their builder is active", async () => {
  const task = makeTask({ current_run_pid: 41_001 });
  const h = makeHarness({
    tasks: [task],
    // Even if GitHub discovery unexpectedly returns the owner's PR, task
    // coordination must prevent the inbound path from bypassing the builder.
    openReviewRequests: [makeRequest()],
    prHeadShas: { [task.pr_url!]: "task-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.activeTaskPids.get(task.id), 41_001);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.reviews[task.pr_url!], undefined);
});

test("pollOnce reclassifies cached inbound reviews owned by unschedulable live tasks", async () => {
  const pausedTask = makeTask({
    id: "paused-task",
    paused: true,
  });
  const disabledTask = makeTask({
    id: "disabled-task",
    pr_url: "https://github.com/acme/widget/pull/2",
    reviewer_agent_enabled: false,
  });
  const builderTask = makeTask({
    id: "builder-task",
    pr_url: "https://github.com/acme/widget/pull/3",
    current_run_pid: 41_003,
  });
  const tasks = [pausedTask, disabledTask, builderTask];
  const inboundRequests = tasks.map((task, index) =>
    makeRequest({
      pr_url: task.pr_url!,
      pr_number: index + 1,
      head_sha: `fresh-head-${index + 1}`,
    })
  );
  const reviews = Object.fromEntries(
    inboundRequests.map((request, index) => [
      request.pr_url,
      makeSummary(
        { ...request, head_sha: `cached-head-${index + 1}` },
        {
          summary: "Inbound result must not remain actionable.",
          generated_at: "2026-05-01T00:05:00.000Z",
          agent_review_status: "ready_for_human_approval",
          my_approval_sha: `cached-head-${index + 1}`,
        }
      ),
    ])
  );
  // Cover both a still-discovered inbound request and a cached row that is no
  // longer returned by discovery.
  const h = makeHarness({
    tasks,
    openReviewRequests: inboundRequests.slice(1),
    reviews,
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.spawnCalls, []);
  for (const [index, task] of tasks.entries()) {
    const stored = h.reviews[task.pr_url!];
    assert.equal(stored.source, "task");
    assert.equal(stored.task_id, task.id);
    assert.equal(stored.task_title, task.title);
    assert.equal(
      stored.head_sha,
      index === 0 ? `cached-head-${index + 1}` : `fresh-head-${index + 1}`
    );
    assert.equal(stored.summary, "");
    assert.equal(stored.agent_review_status, undefined);
    assert.equal(stored.my_approval_sha, undefined);
    assert.equal(deriveReviewState(stored), "queued");
  }
});

test("pollOnce does not claim an inbound review after its task stops being live", async () => {
  const task = makeTask({ paused: true });
  const inbound = makeRequest();
  const h = makeHarness({
    tasks: [task],
    openReviewRequests: [inbound],
    reviews: {
      [inbound.pr_url]: makeSummary(inbound, {
        summary: "Keep the inbound result.",
        generated_at: "2026-05-01T00:05:00.000Z",
      }),
    },
  });
  h.deps.getTask = async (id) => {
    const current = h.tasks.find((candidate) => candidate.id === id);
    return current ? { ...current, status: "merged" } : undefined;
  };

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.reviews[inbound.pr_url].source, undefined);
  assert.equal(h.reviews[inbound.pr_url].summary, "Keep the inbound result.");
  assert.deepEqual(h.spawnCalls, []);
});

test("pollOnce rechecks task policy immediately before spawning a review", async () => {
  const task = makeTask();
  const h = makeHarness({
    tasks: [task],
    prHeadShas: { [task.pr_url!]: "task-head" },
  });
  h.deps.getTask = async (id) => {
    const current = h.tasks.find((candidate) => candidate.id === id);
    return current
      ? { ...current, reviewer_agent_enabled: false }
      : undefined;
  };

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.spawnCalls, []);
  assert.equal(h.reviews[task.pr_url!].source, "task");
  assert.equal(deriveReviewState(h.reviews[task.pr_url!]), "queued");
});

test("pollOnce does not spawn over a review claimed during its final task check", async () => {
  const task = makeTask();
  const h = makeHarness({
    tasks: [task],
    prHeadShas: { [task.pr_url!]: "task-head" },
  });
  h.deps.getTask = async (id) => {
    const current = h.tasks.find((candidate) => candidate.id === id);
    if (current) {
      h.reviews[task.pr_url!] = {
        ...h.reviews[task.pr_url!],
        current_run_pid: 70_002,
        current_run_id: "external-owner",
      };
    }
    return current;
  };

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.spawnCalls, []);
  assert.equal(h.reviews[task.pr_url!].current_run_pid, 70_002);
  assert.equal(h.reviews[task.pr_url!].current_run_id, "external-owner");
});

test("pollOnce stops a live retired task reviewer before unified review", async () => {
  const task = makeTask({
    current_run_pid: 41_002,
    current_run_mode: "reviewer" as never,
  });
  const h = makeHarness({
    tasks: [task],
    prHeadShas: { [task.pr_url!]: "task-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.stoppedLegacyReviewerPids, [41_002]);
  assert.equal(h.activeTaskPids.get(task.id), 41_002);
  assert.deepEqual(h.spawnCalls, []);
});

test("pollOnce skips a head covered during migration and reviews the next head", async () => {
  const task = makeTask({ review_migration_head_sha: "legacy-head" });
  const heads = { [task.pr_url!]: "legacy-head" };
  const h = makeHarness({ tasks: [task], prHeadShas: heads });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.tasks[0].review_migration_head_sha, "legacy-head");

  heads[task.pr_url!] = "unified-head";
  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.tasks[0].review_migration_head_sha, undefined);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].head_sha, "unified-head");
  assert.equal(h.spawnCalls[0].source, "task");
});

test("pollOnce deduplicates an inbound request in favor of task ownership", async () => {
  const task = makeTask({
    resume_requested: true,
    resume_run_mode: "review",
  });
  const inbound = makeRequest({
    title: "Inbound title must not win",
    author: "someone-else",
    head_sha: "same-head",
    my_approval_sha: "same-head",
  });
  const h = makeHarness({
    tasks: [task],
    openReviewRequests: [inbound],
    reviews: {
      [inbound.pr_url]: makeSummary(inbound, {
        source: "inbound",
        summary: "Reviewed without task context.",
        summary_head_sha: inbound.head_sha,
        generated_at: "2026-05-01T00:05:00.000Z",
      }),
    },
    prHeadShas: { [task.pr_url!]: "same-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.builderCalls, []);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].source, "task");
  assert.equal(h.spawnCalls[0].task_id, task.id);
  assert.equal(h.spawnCalls[0].title, task.title);
  assert.equal(h.spawnCalls[0].my_approval_sha, undefined);
  assert.equal(h.reviews[task.pr_url!].source, "task");
  assert.equal(h.reviews[task.pr_url!].task_id, task.id);
});

test("pollOnce invalidates review context when the head and owner change together", async () => {
  const task = makeTask();
  const inbound = makeRequest({
    head_sha: "old-head",
    title: "Inbound title",
    author: "someone-else",
  });
  const h = makeHarness({
    tasks: [task],
    reviews: {
      [inbound.pr_url]: makeSummary(inbound, {
        source: "inbound",
        summary: "Reviewed under inbound policy.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:05:00.000Z",
        session_id: "inbound-session",
        session_profile: { runtime: "codex", model: "gpt-old" },
        followups: [
          {
            asked_at: "2026-05-01T00:06:00.000Z",
            question: "old question",
            answered_at: "2026-05-01T00:07:00.000Z",
            answer: "old answer",
            resumed: true,
          },
        ],
      }),
    },
    prHeadShas: { [task.pr_url!]: "new-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].source, "task");
  const stored = h.reviews[task.pr_url!];
  assert.equal(stored.source, "task");
  assert.equal(stored.head_sha, "new-head");
  assert.equal(stored.summary, "");
  assert.equal(stored.summary_head_sha, undefined);
  assert.equal(stored.session_id, undefined);
  assert.equal(stored.session_profile, undefined);
  assert.deepEqual(stored.followups, []);
});

test("pollOnce retries an errored current-head refresh after backoff", async () => {
  const pr = makeRequest();
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: {
      [pr.pr_url]: makeSummary(pr, {
        summary: "Last successful summary.",
        summary_head_sha: pr.head_sha,
        error: "Temporary runtime failure",
        error_at: "2020-01-01T00:00:00.000Z",
        runtime: "claude",
        session_profile: { runtime: "claude" },
      }),
    },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].pr_url, pr.pr_url);
});

test("pollOnce lets resumable implementation work proceed when a review head is unavailable", async () => {
  const task = makeTask({
    resume_requested: true,
    resume_run_mode: "review",
  });
  const h = makeHarness({ tasks: [task] });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.builderCalls.length, 1);
  assert.equal(h.builderCalls[0].mode, "review");
  assert.deepEqual(h.spawnCalls, []);
});

test("pollOnce reviews the fetched head before resuming a task builder", async () => {
  const task = makeTask({
    resume_requested: true,
    resume_run_mode: "review",
  });
  const cachedRequest = makeRequest({
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
    head_sha: "old-head",
  });
  const h = makeHarness({
    tasks: [task],
    reviews: {
      [task.pr_url!]: makeSummary(cachedRequest, {
        summary: "The old head was clean.",
        summary_head_sha: "old-head",
      }),
    },
    prHeadShas: { [task.pr_url!]: "new-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.builderCalls, []);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].head_sha, "new-head");
});

test("errored reviews back off unless the reviewer profile changes", () => {
  const request = makeRequest();
  const failedAt = new Date("2026-05-01T00:00:00.000Z");
  const review = makeSummary(request, {
    error: "Unsupported model",
    error_at: failedAt.toISOString(),
    runtime: "codex",
    effort: "high",
    model: "gpt-unavailable",
    session_profile: {
      runtime: "codex",
      effort: "high",
      model: "gpt-unavailable",
    },
  });
  const sameProfile = makeConfig({
    review_runtime: "codex",
    review_effort: "high",
    review_model: "gpt-unavailable",
  });

  assert.equal(
    shouldRetryErroredReview(
      review,
      sameProfile,
      failedAt.getTime() + REVIEW_ERROR_RETRY_MS - 1
    ),
    false
  );
  assert.equal(
    shouldRetryErroredReview(
      review,
      sameProfile,
      failedAt.getTime() + REVIEW_ERROR_RETRY_MS
    ),
    true
  );
  assert.equal(
    shouldRetryErroredReview(
      review,
      { ...sameProfile, review_model: "gpt-fixed" },
      failedAt.getTime() + 1
    ),
    true
  );
});

test("pollOnce keeps a task builder queued while its shared review is running", async () => {
  const task = makeTask({
    resume_requested: true,
    resume_run_mode: "review",
  });
  const request = makeRequest({
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
  });
  const cached = makeSummary(request, {
    current_run_pid: 41_002,
  });
  const h = makeHarness({
    tasks: [task],
    reviews: { [request.pr_url]: cached },
    prHeadShas: { [task.pr_url!]: request.head_sha },
    isPidRunning: (pid) => pid === 41_002,
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.builderCalls, []);
  assert.equal(h.tasks[0].resume_requested, true);
  assert.equal(h.tasks[0].resume_run_mode, "review");
  assert.equal(h.activeReviewPids.get(request.pr_url), 41_002);
  assert.deepEqual(h.spawnCalls, []);
});

test("task review completion wakes the builder only for current actionable findings", async () => {
  const actionableTask = makeTask();
  const actionable = makeHarness({
    tasks: [actionableTask],
    prHeadShas: { [actionableTask.pr_url!]: "actionable-head" },
  });
  await pollOnce(
    actionable.activeTaskPids,
    actionable.deps,
    actionable.activeReviewPids
  );
  assert.equal(actionable.reviewCompletions.length, 1);

  const actionableRequest = actionable.spawnCalls[0];
  await actionable.reviewCompletions[0](
    makeSummary(actionableRequest, {
      summary: "## Summary\nChanges are required.",
      summary_head_sha: actionableRequest.head_sha,
      generated_at: "2026-05-01T00:20:00.000Z",
      agent_review_status: "needs_author_changes",
      current_run_pid: undefined,
    })
  );

  assert.equal(actionable.tasks[0].resume_requested, true);
  assert.equal(actionable.tasks[0].resume_run_mode, "review");
  assert.equal(actionable.activeReviewPids.has(actionableRequest.pr_url), false);

  const cleanTask = makeTask({
    id: "clean-task",
    pr_url: "https://github.com/acme/widget/pull/2",
  });
  const clean = makeHarness({
    tasks: [cleanTask],
    prHeadShas: { [cleanTask.pr_url!]: "clean-head" },
  });
  await pollOnce(clean.activeTaskPids, clean.deps, clean.activeReviewPids);
  assert.equal(clean.reviewCompletions.length, 1);

  const cleanRequest = clean.spawnCalls[0];
  await clean.reviewCompletions[0](
    makeSummary(cleanRequest, {
      summary: "## Summary\nNo blocking findings.",
      summary_head_sha: cleanRequest.head_sha,
      generated_at: "2026-05-01T00:20:00.000Z",
      agent_review_status: "ready_for_human_approval",
      current_run_pid: undefined,
    })
  );

  assert.equal(clean.tasks[0].resume_requested, undefined);
  assert.equal(clean.tasks[0].resume_run_mode, undefined);
  assert.equal(clean.activeReviewPids.has(cleanRequest.pr_url), false);

  const optedOutTask = makeTask({ id: "opted-out-task" });
  const optedOut = makeHarness({
    tasks: [optedOutTask],
    prHeadShas: { [optedOutTask.pr_url!]: "opted-out-head" },
  });
  await pollOnce(
    optedOut.activeTaskPids,
    optedOut.deps,
    optedOut.activeReviewPids
  );
  assert.equal(optedOut.reviewCompletions.length, 1);
  optedOut.tasks[0].reviewer_agent_enabled = false;

  const optedOutRequest = optedOut.spawnCalls[0];
  await optedOut.reviewCompletions[0](
    makeSummary(optedOutRequest, {
      summary: "## Summary\nChanges are required.",
      summary_head_sha: optedOutRequest.head_sha,
      generated_at: "2026-05-01T00:20:00.000Z",
      agent_review_status: "needs_author_changes",
      current_run_pid: undefined,
    })
  );

  assert.equal(optedOut.tasks[0].resume_requested, undefined);
  assert.equal(optedOut.tasks[0].resume_run_mode, undefined);
});

test("paused and automatic-review-disabled task PRs stay live without spawning", async () => {
  const pausedTask = makeTask({ paused: true });
  const disabledTask = makeTask({
    id: "disabled-task",
    pr_url: "https://github.com/acme/widget/pull/2",
    reviewer_agent_enabled: false,
  });
  const neverReviewedDisabledTask = makeTask({
    id: "never-reviewed-disabled-task",
    pr_url: "https://github.com/acme/widget/pull/3",
    reviewer_agent_enabled: false,
  });
  const pausedRequest = makeRequest({
    source: "task",
    task_id: pausedTask.id,
  });
  const disabledRequest = makeRequest({
    source: "task",
    task_id: disabledTask.id,
    task_title: disabledTask.title,
    task_description: disabledTask.description,
    task_plan: disabledTask.plan,
    pr_url: disabledTask.pr_url!,
    pr_number: 2,
    head_sha: "disabled-head",
  });
  const h = makeHarness({
    tasks: [pausedTask, disabledTask, neverReviewedDisabledTask],
    reviews: {
      [pausedRequest.pr_url]: makeSummary(pausedRequest, {
        summary: "paused summary",
        generated_at: "2026-05-01T00:00:00.000Z",
      }),
      [disabledRequest.pr_url]: makeSummary(disabledRequest, {
        summary: "disabled summary",
        summary_head_sha: "disabled-head",
        generated_at: "2026-05-01T00:00:00.000Z",
        agent_review_status: "ready_for_human_approval",
      }),
    },
    prHeadShas: {
      [disabledRequest.pr_url]: "disabled-new-head",
      [neverReviewedDisabledTask.pr_url!]: "never-reviewed-head",
    },
    prFinalStates: {
      [pausedRequest.pr_url]: "closed",
      [disabledRequest.pr_url]: null,
    },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.deepEqual(h.spawnCalls, []);
  assert.equal(h.reviews[pausedRequest.pr_url].final_at, undefined);
  assert.equal(h.reviews[disabledRequest.pr_url].final_at, undefined);
  assert.equal(h.reviews[disabledRequest.pr_url].head_sha, "disabled-new-head");
  assert.equal(h.reviews[disabledRequest.pr_url].summary_head_sha, "disabled-head");
  assert.equal(h.reviews[disabledRequest.pr_url].summary, "disabled summary");
  assert.equal(h.reviews[disabledRequest.pr_url].agent_review_status, undefined);
  assert.equal(
    deriveReviewState(h.reviews[disabledRequest.pr_url]),
    "re_reviewing"
  );
  assert.equal(h.reviews[neverReviewedDisabledTask.pr_url!], undefined);
  assert.deepEqual(h.deletedPrUrls, []);
});

test("re-enabling automatic review schedules the refreshed stale head once", async () => {
  const task = makeTask({ reviewer_agent_enabled: false });
  const oldRequest = makeRequest({
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
    head_sha: "old-head",
  });
  const h = makeHarness({
    tasks: [task],
    reviews: {
      [task.pr_url!]: makeSummary(oldRequest, {
        summary: "Reviewed before opt-out.",
        summary_head_sha: "old-head",
        generated_at: "2026-05-01T00:00:00.000Z",
        agent_review_status: "ready_for_human_approval",
      }),
    },
    prHeadShas: { [task.pr_url!]: "new-head" },
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(deriveReviewState(h.reviews[task.pr_url!]), "re_reviewing");

  h.tasks[0].reviewer_agent_enabled = true;
  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].head_sha, "new-head");
});

test("a merged task-owned review enters the shared retrospective flow", async () => {
  const task = makeTask();
  const request = makeRequest({
    source: "task",
    task_id: task.id,
    task_title: task.title,
    task_description: task.description,
    task_plan: task.plan,
  });
  const h = makeHarness({
    tasks: [task],
    reviews: {
      [request.pr_url]: makeSummary(request, {
        summary: "## Summary\nReviewed task implementation.",
        summary_head_sha: request.head_sha,
        generated_at: "2026-05-01T00:00:00.000Z",
        agent_review_status: "ready_for_human_approval",
      }),
    },
    prFinalStates: { [request.pr_url]: "merged" },
    learnings: "Existing learning context",
  });

  await pollOnce(h.activeTaskPids, h.deps, h.activeReviewPids);

  assert.equal(h.tasks[0].status, "merged");
  assert.equal(h.reviews[request.pr_url].final_state, "merged");
  assert.equal(h.reviews[request.pr_url].retro_status, "pending");
  assert.equal(h.retroCalls.length, 1);
  assert.equal(h.retroCalls[0].review.source, "task");
  assert.equal(h.retroCalls[0].review.task_id, task.id);
  assert.equal(h.retroCalls[0].learningsBefore, "Existing learning context");
});

test("pollOnce stamps final_at when a PR drops out of the live list", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: "closed" },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored.final_at, "final_at should be stamped");
  // Summary is preserved during the 24h grace period.
  assert.equal(stored.summary, "old summary");
  assert.equal(h.deletedPrUrls.length, 0);
});

test("final-state lookup does not overwrite a review claimed while lookup is in flight", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  let lookupStartedResolve!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    lookupStartedResolve = resolve;
  });
  let finishLookup!: (state: "closed") => void;
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPRMergedOrClosed: async () => {
      lookupStartedResolve();
      return new Promise<"closed">((resolve) => {
        finishLookup = resolve;
      });
    },
  });

  const poll = pollOnce(new Map(), h.deps, h.activeReviewPids);
  await lookupStarted;
  h.reviews[pr.pr_url] = makeSummary(pr, {
    summary: "new run in flight",
    generated_at: "2026-05-01T00:10:00.000Z",
    current_run_pid: 70_000,
    current_run_id: "new-owner",
  });
  finishLookup("closed");
  await poll;

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.summary, "new run in flight");
  assert.equal(stored.current_run_pid, 70_000);
  assert.equal(stored.current_run_id, "new-owner");
  assert.equal(stored.final_at, undefined);
  assert.equal(stored.final_state, undefined);
});

test("final-state lookup merges into a review completed while lookup is in flight", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  let lookupStartedResolve!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    lookupStartedResolve = resolve;
  });
  let finishLookup!: (state: "closed") => void;
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPRMergedOrClosed: async () => {
      lookupStartedResolve();
      return new Promise<"closed">((resolve) => {
        finishLookup = resolve;
      });
    },
  });

  const poll = pollOnce(new Map(), h.deps, h.activeReviewPids);
  await lookupStarted;
  h.reviews[pr.pr_url] = makeSummary(pr, {
    summary: "new completed summary",
    summary_head_sha: pr.head_sha,
    generated_at: "2026-05-01T00:10:00.000Z",
    session_id: "new-session",
  });
  finishLookup("closed");
  await poll;

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.summary, "new completed summary");
  assert.equal(stored.session_id, "new-session");
  assert.equal(stored.final_state, "closed");
  assert.ok(stored.final_at);
});

test("pollOnce marks merged reviews pending and spawns one retro", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    agent_review_status: "needs_author_changes",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: "merged" },
    learnings: "existing lessons",
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_state, "merged");
  assert.equal(stored.retro_status, "pending");
  assert.equal(stored.retro_run_pid, 50_000);
  assert.equal(h.retroCalls.length, 1);
  assert.equal(h.retroCalls[0].review.pr_url, pr.pr_url);
  assert.equal(h.retroCalls[0].learningsBefore, "existing lessons");
});

test("pollOnce preserves terminal retro status when refinalizing merged reviews", async () => {
  const done = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
  });
  const errored = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: {
      [done.pr_url]: makeSummary(done, {
        summary: "done summary",
        generated_at: "2026-05-01T00:00:00.000Z",
        retro_status: "done",
        retro_done_at: "2026-05-01T00:20:00.000Z",
      }),
      [errored.pr_url]: makeSummary(errored, {
        summary: "errored summary",
        generated_at: "2026-05-01T00:00:00.000Z",
        retro_status: "error",
        retro_error: "Retro failed.",
      }),
    },
    prFinalStates: {
      [done.pr_url]: "merged",
      [errored.pr_url]: "merged",
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.ok(h.reviews[done.pr_url].final_at);
  assert.equal(h.reviews[done.pr_url].final_state, "merged");
  assert.equal(h.reviews[done.pr_url].retro_status, "done");
  assert.equal(
    h.reviews[done.pr_url].retro_done_at,
    "2026-05-01T00:20:00.000Z"
  );
  assert.ok(h.reviews[errored.pr_url].final_at);
  assert.equal(h.reviews[errored.pr_url].final_state, "merged");
  assert.equal(h.reviews[errored.pr_url].retro_status, "error");
  assert.equal(h.reviews[errored.pr_url].retro_error, "Retro failed.");
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce stamps closed reviews without spawning retros", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: "closed" },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_state, "closed");
  assert.equal(stored.retro_status, undefined);
  assert.equal(stored.retro_run_pid, undefined);
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce leaves unknown final review state retryable", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: null },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_at, undefined);
  assert.equal(stored.final_state, undefined);
  assert.ok(stored.final_state_lookup_started_at);
  assert.equal(
    stored.final_state_lookup_error,
    "GitHub did not return merged or closed state."
  );
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce keeps unknown final review state retryable after retry window", async () => {
  const pr = makeRequest();
  const retryStartedAt = new Date(
    Date.now() - (FINAL_CLASSIFICATION_RETRY_MS + 60_000)
  ).toISOString();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_state_lookup_started_at: retryStartedAt,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: null },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_at, undefined);
  assert.equal(stored.final_state, undefined);
  assert.equal(stored.final_state_lookup_started_at, retryStartedAt);
  assert.equal(stored.final_state_lookup_error_started_at, undefined);
  assert.equal(
    stored.final_state_lookup_error,
    "GitHub did not return merged or closed state."
  );
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
  assert.deepEqual(h.deletedPrUrls, []);
});

test("pollOnce does not expire on first lookup error after long unknown state", async () => {
  const pr = makeRequest();
  const retryStartedAt = new Date(
    Date.now() - (FINAL_CLASSIFICATION_RETRY_MS + 60_000)
  ).toISOString();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_state_lookup_started_at: retryStartedAt,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPRMergedOrClosed: async () => {
      throw new Error("GitHub unavailable");
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_at, undefined);
  assert.equal(stored.final_state, undefined);
  assert.equal(stored.final_state_lookup_started_at, retryStartedAt);
  assert.ok(stored.final_state_lookup_error_started_at);
  assert.equal(stored.final_state_lookup_error, "GitHub unavailable");
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
  assert.deepEqual(h.deletedPrUrls, []);
});

test("pollOnce finalizes repeated final-state lookup errors after retry window", async () => {
  const pr = makeRequest();
  const retryStartedAt = new Date(
    Date.now() - (FINAL_CLASSIFICATION_RETRY_MS + 60_000)
  ).toISOString();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_state_lookup_started_at: retryStartedAt,
    final_state_lookup_error_started_at: retryStartedAt,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPRMergedOrClosed: async () => {
      throw new Error("GitHub unavailable");
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored.final_at);
  assert.equal(stored.final_state, undefined);
  assert.equal(stored.final_state_lookup_started_at, undefined);
  assert.match(
    stored.final_state_lookup_error || "",
    /Final-state lookup timed out.*GitHub unavailable/
  );
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
  assert.deepEqual(h.deletedPrUrls, []);
});

test("pollOnce continues finalizing reviews when classification throws", async () => {
  const a = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
  });
  const b = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
  });
  const cachedA = makeSummary(a, {
    summary: "old summary a",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const cachedB = makeSummary(b, {
    summary: "old summary b",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [a.pr_url]: cachedA, [b.pr_url]: cachedB },
    isPRMergedOrClosed: async (prUrl) => {
      if (prUrl === a.pr_url) throw new Error("GitHub unavailable");
      return "merged";
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[a.pr_url].final_at, undefined);
  assert.equal(h.reviews[a.pr_url].final_state, undefined);
  assert.equal(
    h.reviews[a.pr_url].final_state_lookup_error,
    "GitHub unavailable"
  );
  assert.equal(h.reviews[a.pr_url].retro_status, undefined);
  assert.equal(h.reviews[b.pr_url].final_state, "merged");
  assert.equal(h.reviews[b.pr_url].retro_status, "pending");
  assert.equal(h.retroCalls.length, 1);
  assert.equal(h.retroCalls[0].review.pr_url, b.pr_url);
});

test("pollOnce does not spawn retros when learning is disabled", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    config: { review_learning_enabled: false },
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: "merged" },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.final_state, "merged");
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce serializes pending retros", async () => {
  const a = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
  });
  const b = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
  });
  const finalAt = new Date().toISOString();
  const h = makeHarness({
    openReviewRequests: [],
    reviews: {
      [a.pr_url]: makeSummary(a, {
        summary: "summary a",
        generated_at: finalAt,
        final_at: finalAt,
        final_state: "merged",
        retro_status: "pending",
      }),
      [b.pr_url]: makeSummary(b, {
        summary: "summary b",
        generated_at: finalAt,
        final_at: finalAt,
        final_state: "merged",
        retro_status: "pending",
      }),
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);
  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.retroCalls.length, 1);
  assert.equal(h.retroCalls[0].review.pr_url, a.pr_url);
});

test("pollOnce rehydrates a running persisted retro pid before scheduling", async () => {
  const a = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
  });
  const b = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
  });
  const finalAt = new Date().toISOString();
  const h = makeHarness({
    openReviewRequests: [],
    reviews: {
      [a.pr_url]: makeSummary(a, {
        summary: "summary a",
        generated_at: finalAt,
        final_at: finalAt,
        final_state: "merged",
        retro_status: "pending",
        retro_run_pid: 60_000,
      }),
      [b.pr_url]: makeSummary(b, {
        summary: "summary b",
        generated_at: finalAt,
        final_at: finalAt,
        final_state: "merged",
        retro_status: "pending",
      }),
    },
    isPidRunning: (pid) => pid === 60_000,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.retroCalls.length, 0);
  assert.equal(h.reviews[a.pr_url].retro_run_pid, 60_000);
  assert.equal(h.reviews[b.pr_url].retro_run_pid, undefined);
});

test("pollOnce marks dead persisted retro pids as errors", async () => {
  const pr = makeRequest();
  const finalAt = new Date().toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: finalAt,
    final_state: "merged",
    retro_status: "pending",
    retro_run_pid: 60_000,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPidRunning: () => false,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.retroCalls.length, 0);
  assert.equal(h.reviews[pr.pr_url].retro_status, "error");
  assert.match(
    h.reviews[pr.pr_url].retro_error || "",
    /exited before completion/
  );
  assert.equal(h.reviews[pr.pr_url].retro_run_pid, undefined);
});

test("dead-retro reconciliation does not overwrite a concurrent completion", async () => {
  const pr = makeRequest();
  const finalAt = new Date().toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: finalAt,
    final_state: "merged",
    retro_status: "pending",
    retro_run_pid: 60_001,
  });
  let completeRetro = () => {};
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPidRunning: (pid) => {
      if (pid === 60_001) completeRetro();
      return false;
    },
  });
  completeRetro = () => {
    h.reviews[pr.pr_url] = makeSummary(pr, {
      ...h.reviews[pr.pr_url],
      retro_status: "done",
      retro_done_at: "2026-05-01T00:30:00.000Z",
      retro_run_pid: undefined,
    });
  };

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.retro_status, "done");
  assert.equal(stored.retro_done_at, "2026-05-01T00:30:00.000Z");
  assert.equal(stored.retro_error, undefined);
  assert.equal(stored.retro_run_pid, undefined);
});

test("pollOnce keeps in-flight retros through the review GC window", async () => {
  const pr = makeRequest();
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: aged,
    final_state: "merged",
    retro_status: "pending",
    retro_run_pid: 60_000,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    isPidRunning: (pid) => pid === 60_000,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.deepEqual(h.deletedPrUrls, []);
  assert.ok(h.reviews[pr.pr_url]);
});

test("pollOnce keeps queued pending retros through the review GC window", async () => {
  const inFlight = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
  });
  const queued = makeRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
  });
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const h = makeHarness({
    openReviewRequests: [],
    reviews: {
      [inFlight.pr_url]: makeSummary(inFlight, {
        summary: "in flight",
        generated_at: "2026-05-01T00:00:00.000Z",
        final_at: aged,
        final_state: "merged",
        retro_status: "pending",
        retro_run_pid: 60_000,
      }),
      [queued.pr_url]: makeSummary(queued, {
        summary: "queued",
        generated_at: "2026-05-01T00:00:00.000Z",
        final_at: aged,
        final_state: "merged",
        retro_status: "pending",
      }),
    },
    isPidRunning: (pid) => pid === 60_000,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.deepEqual(h.deletedPrUrls, []);
  assert.ok(h.reviews[queued.pr_url]);
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce prunes queued pending retros when learning is disabled", async () => {
  const pr = makeRequest();
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const cached = makeSummary(pr, {
    summary: "queued",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: aged,
    final_state: "merged",
    retro_status: "pending",
  });
  const h = makeHarness({
    config: { review_learning_enabled: false },
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.deepEqual(h.deletedPrUrls, [pr.pr_url]);
  assert.equal(h.reviews[pr.pr_url], undefined);
  assert.equal(h.retroCalls.length, 0);
});

test("pollOnce deletes review entries whose final_at is older than the prune age", async () => {
  const pr = makeRequest();
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: aged,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.deepEqual(h.deletedPrUrls, [pr.pr_url]);
  assert.equal(h.reviews[pr.pr_url], undefined);
});

test("review GC does not delete a record claimed after its snapshot", async () => {
  const pr = makeRequest();
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: aged,
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
  });
  const conditionalDelete = h.deps.deleteReviewSummaryIf!;
  h.deps.deleteReviewSummaryIf = async (prUrl, predicate) => {
    h.reviews[prUrl] = makeSummary(pr, {
      ...h.reviews[prUrl],
      current_run_pid: 70_001,
      current_run_id: "new-owner",
    });
    return conditionalDelete(prUrl, predicate);
  };

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.deepEqual(h.deletedPrUrls, []);
  assert.equal(h.reviews[pr.pr_url].current_run_pid, 70_001);
  assert.equal(h.reviews[pr.pr_url].current_run_id, "new-owner");
});

test("pollOnce clears orphaned review pids during pid reconcile", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "previous",
    generated_at: "2026-05-01T00:00:00.000Z",
    current_run_pid: 9999,
  });
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
    isPidRunning: () => false,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].current_run_pid, undefined);
});

test("pollOnce clears an ID-only review owner before finalizing", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "previous",
    generated_at: "2026-05-01T00:00:00.000Z",
    current_run_id: "stopped-run",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    prFinalStates: { [pr.pr_url]: "closed" },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].current_run_id, undefined);
  assert.equal(h.reviews[pr.pr_url].final_state, "closed");
  assert.ok(h.reviews[pr.pr_url].final_at);
});

test("pollOnce clears final_at if a PR comes back into the live list", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "previous",
    generated_at: "2026-05-01T00:00:00.000Z",
    final_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].final_at, undefined);
});
