import test from "node:test";
import assert from "node:assert/strict";

import {
  PRUNE_AGE_MS,
  pollOnce,
  type WorkerRuntimeDeps,
} from "./orchestrator-worker-runtime";
import { withReviewStatus } from "./review-status";
import type {
  OrchestratorConfig,
  ReviewRequest,
  ReviewSummary,
} from "./types";

interface HarnessOptions {
  config?: Partial<OrchestratorConfig>;
  reviews?: Record<string, ReviewSummary>;
  openReviewRequests?: ReviewRequest[];
  prFinalStates?: Record<string, "merged" | "closed" | null>;
  isPidRunning?: (pid: number) => boolean;
  spawnPid?: () => number;
  learnings?: string;
}

interface Harness {
  deps: WorkerRuntimeDeps;
  reviews: Record<string, ReviewSummary>;
  spawnCalls: ReviewRequest[];
  retroCalls: Array<{ review: ReviewSummary; learningsBefore: string }>;
  deletedPrUrls: string[];
  activeReviewPids: Map<string, number>;
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

function makeHarness(options: HarnessOptions = {}): Harness {
  const reviews: Record<string, ReviewSummary> = { ...(options.reviews || {}) };
  const spawnCalls: ReviewRequest[] = [];
  const retroCalls: Array<{ review: ReviewSummary; learningsBefore: string }> = [];
  const deletedPrUrls: string[] = [];
  let nextPid = 50_000;
  const spawnPid = options.spawnPid || (() => nextPid++);

  const deps: WorkerRuntimeDeps = {
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewRequestedPRs: async () => options.openReviewRequests || [],
    getTask: async () => undefined,
    isPRMergedOrClosed: async (prUrl) =>
      options.prFinalStates && prUrl in options.prFinalStates
        ? options.prFinalStates[prUrl]
        : null,
    isPidRunning: options.isPidRunning || (() => true),
    logger: { log: () => {}, error: () => {} },
    readConfig: () => makeConfig(options.config),
    readReviewLearnings: () => options.learnings || "",
    readReviewSummaries: () => Object.values(reviews),
    readReviewSummaryMap: () => ({ ...reviews }),
    readTasks: () => [],
    removeWorktree: async () => {},
    spawnAgentSession: async () => ({
      pid: 0,
      child: {} as never,
    }),
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
      return {
        pid,
        child: {} as never,
        done: (async () => {
          const entry = reviews[request.pr_url] || makeSummary(request);
          await onComplete?.(entry);
          return entry;
        })(),
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
    updateTask: async () => ({}) as never,
    upsertReviewSummary: async (entry) => {
      reviews[entry.pr_url] = withReviewStatus(entry) as ReviewSummary;
      return reviews[entry.pr_url];
    },
    deleteReviewSummary: async (prUrl) => {
      deletedPrUrls.push(prUrl);
      delete reviews[prUrl];
    },
  };

  return {
    deps,
    reviews,
    spawnCalls,
    retroCalls,
    deletedPrUrls,
    activeReviewPids: new Map(),
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

test("pollOnce stamps final_at when a PR drops out of the live list", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored.final_at, "final_at should be stamped");
  // Summary is preserved during the 24h grace period.
  assert.equal(stored.summary, "old summary");
  assert.equal(h.deletedPrUrls.length, 0);
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

test("pollOnce skips retros when merge classification fails", async () => {
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
  assert.ok(stored.final_at);
  assert.equal(stored.final_state, undefined);
  assert.equal(stored.retro_status, undefined);
  assert.equal(h.retroCalls.length, 0);
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
  const finalAt = "2026-05-01T00:00:00.000Z";
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
        final_at: "2026-05-01T00:01:00.000Z",
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
