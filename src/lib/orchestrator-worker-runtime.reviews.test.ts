import test from "node:test";
import assert from "node:assert/strict";

import {
  PRUNE_AGE_MS,
  pollOnce,
  type WorkerRuntimeDeps,
} from "./orchestrator-worker-runtime";
import type {
  OrchestratorConfig,
  ReviewRequest,
  ReviewState,
  ReviewSummary,
} from "./types";

interface HarnessOptions {
  config?: Partial<OrchestratorConfig>;
  reviews?: Record<string, ReviewSummary>;
  openReviewRequests?: ReviewRequest[];
  isPidRunning?: (pid: number) => boolean;
  spawnPid?: () => number;
  lifecycleState?: (prUrl: string) => Promise<ReviewState>;
}

interface Harness {
  deps: WorkerRuntimeDeps;
  reviews: Record<string, ReviewSummary>;
  spawnCalls: ReviewRequest[];
  deletedPrUrls: string[];
  lifecycleCalls: string[];
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
  return {
    ...base,
    summary: "",
    generated_at: "",
    ...overrides,
  };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const reviews: Record<string, ReviewSummary> = { ...(options.reviews || {}) };
  const spawnCalls: ReviewRequest[] = [];
  const deletedPrUrls: string[] = [];
  const lifecycleCalls: string[] = [];
  let nextPid = 50_000;
  const spawnPid = options.spawnPid || (() => nextPid++);

  const deps: WorkerRuntimeDeps = {
    deleteTask: async () => {},
    getPRStateHash: async () => "",
    getPRStatus: async () => "unknown",
    getReviewLifecycleState:
      options.lifecycleState ??
      (async (prUrl) => {
        lifecycleCalls.push(prUrl);
        return "merged_closed";
      }),
    getReviewRequestedPRs: async () => options.openReviewRequests || [],
    getTask: async () => undefined,
    isPRMergedOrClosed: async () => null,
    isPidRunning: options.isPidRunning || (() => true),
    logger: { log: () => {}, error: () => {} },
    readConfig: () => makeConfig(options.config),
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
      // Persist current_run_pid in the in-memory store, mirroring real impl.
      reviews[request.pr_url] = {
        ...(reviews[request.pr_url] || makeSummary(request)),
        ...request,
        current_run_pid: pid,
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
    updateTask: async () => ({}) as never,
    upsertReviewSummary: async (entry) => {
      reviews[entry.pr_url] = { ...entry };
      return reviews[entry.pr_url];
    },
    deleteReviewSummary: async (prUrl) => {
      deletedPrUrls.push(prUrl);
      delete reviews[prUrl];
    },
  };

  // Wrap lifecycleState so we always record calls.
  if (options.lifecycleState) {
    const original = deps.getReviewLifecycleState;
    deps.getReviewLifecycleState = async (prUrl) => {
      lifecycleCalls.push(prUrl);
      return original(prUrl);
    };
  }

  return {
    deps,
    reviews,
    spawnCalls,
    deletedPrUrls,
    lifecycleCalls,
    activeReviewPids: new Map(),
  };
}

test("pollOnce upserts a brand-new PR as needs_approval and spawns a summary", async () => {
  const pr = makeRequest();
  const h = makeHarness({ openReviewRequests: [pr] });
  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored, "review should be persisted");
  assert.equal(stored.review_state, "needs_approval");
  assert.equal(stored.head_sha, "abc123");
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.activeReviewPids.has(pr.pr_url), true);
});

test("pollOnce skips spawn when cached entry has matching head SHA and a summary", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "previous summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_state: "needs_approval",
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

test("pollOnce clears summary + session + followups when head SHA changes", async () => {
  const pr = makeRequest({ head_sha: "newSha" });
  const cached = makeSummary(makeRequest({ head_sha: "oldSha" }), {
    summary: "stale",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_state: "needs_approval",
    session_id: "sess-1",
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

  // After the SHA-change upsert + spawn, the stored entry has the new SHA,
  // session/followups cleared, and current_run_pid set by spawn.
  const stored = h.reviews[pr.pr_url];
  assert.equal(stored.head_sha, "newSha");
  assert.equal(stored.session_id, undefined);
  assert.deepEqual(stored.followups, []);
  assert.equal(h.spawnCalls.length, 1);
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

test("pollOnce stamps final_at + review_state when a PR drops out of the live list", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old summary",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_state: "needs_approval",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    lifecycleState: async () => "approved",
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  const stored = h.reviews[pr.pr_url];
  assert.ok(stored.final_at, "final_at should be stamped");
  assert.equal(stored.review_state, "approved");
  assert.deepEqual(h.lifecycleCalls, [pr.pr_url]);
  // Summary is preserved during the 24h grace period.
  assert.equal(stored.summary, "old summary");
  assert.equal(h.deletedPrUrls.length, 0);
});

test("pollOnce deletes review entries whose final_at is older than the prune age", async () => {
  const pr = makeRequest();
  const aged = new Date(Date.now() - (PRUNE_AGE_MS + 60_000)).toISOString();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_state: "merged_closed",
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
    review_state: "needs_approval",
    current_run_pid: 9999,
  });
  const h = makeHarness({
    openReviewRequests: [pr],
    reviews: { [pr.pr_url]: cached },
    isPidRunning: () => false,
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].current_run_pid, undefined);
  // After clearing the stale pid the worker can spawn a new summary
  // because the cached summary is preserved but the entry isn't "in flight".
  // We don't assert on spawn count — what matters is the orphan was reset.
});

test("pollOnce surfaces lifecycle-lookup failures by defaulting to merged_closed", async () => {
  const pr = makeRequest();
  const cached = makeSummary(pr, {
    summary: "old",
    generated_at: "2026-05-01T00:00:00.000Z",
    review_state: "needs_approval",
  });
  const h = makeHarness({
    openReviewRequests: [],
    reviews: { [pr.pr_url]: cached },
    lifecycleState: async () => {
      throw new Error("network down");
    },
  });

  await pollOnce(new Map(), h.deps, h.activeReviewPids);

  assert.equal(h.reviews[pr.pr_url].review_state, "merged_closed");
  assert.ok(h.reviews[pr.pr_url].final_at);
});
