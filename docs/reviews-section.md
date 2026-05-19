# Plan: Reviews Section for Cortex City

## Context

Cortex City currently manages tasks, agents, and sessions for outgoing PR work, but offers nothing for the *inbound* side of the workflow: PRs where the user is being asked to review someone else's code. Today, the user has to leave Cortex City and triage these on GitHub.

Goal: add a **Reviews** section that

- lists every open PR on GitHub where the signed-in user is an individually requested reviewer (across all repos, not just cortex-managed ones),
- shows an agent-generated summary of each PR so triage is fast,
- lets the user open, regenerate, approve, or request changes from inside Cortex City.

Per user input:
- Scope: **all** review requests for the authenticated `gh` user (no repo filter).
- Summary: **auto on first view**, cached keyed on PR head SHA, with manual **regenerate** button.
- Runtime: a single, user-editable **review prompt** lives in Cortex City config (not per-agent). The wrapper prefixes a fixed line `Review this PR: <pr_url>`. User picks **runtime (claude | codex)** and **effort level** in settings (with per-run override on the page).
- Row actions: Open PR · Regenerate summary · Approve / Request changes (inline GH review) · **Ask follow-up** (chat with the agent about its summary).
- **Session reuse rule**: the *only* place we resume an existing agent session is the follow-up flow. Initial summary = fresh session. Force-regenerate = fresh session. Follow-up question = resume the session that produced the current cached summary; if that session can no longer be resumed (or no `session_id` was captured), start a new session and seed it with the prior summary as context.
- **Garbage collection**: cached review data is pruned 24 hours after the PR is observed merged/closed (or 24 hours after it disappears from the "review-requested:@me" list, treating that as closure). This matches the existing 24h retention for final tasks (`PRUNE_AGE_MS` in `src/lib/orchestrator-worker-runtime.ts:15`).

## Architecture

A new lightweight, **task-free** runner — review summarization does not spawn a worktree, does not create a `Task`, does not touch the per-task pid bookkeeping. It shells out to `claude -p` / `codex exec` from `process.cwd()`, captures stdout, persists to `.cortex/reviews.json` keyed on `pr_url`.

**Polling lives in the existing orchestrator worker, not on the client.** Mirrors the existing pattern at `src/lib/orchestrator-worker-runtime.ts:293-346` ("scan in_review tasks") where the worker polls GitHub for outgoing-PR state. Concretely:

- Every worker tick (`config.poll_interval_seconds`, default 30s) `pollOnce` calls `getReviewRequestedPRs()` and reconciles `.cortex/reviews.json`: adds new PRs, updates `head_sha` / `pr_status`, drops entries that have left the open-review-requested list (handled by the GC phase below).
- For any entry that has no summary yet, or whose cached `head_sha` differs from the live one, the worker spawns a **review run** via a dedicated `spawnReviewSummary()` (analogous to `spawnAgentSession` but with no worktree, no session-resume, no `Task` row). It tracks an in-memory `activeReviewPids` map so the next tick doesn't re-fire a run that's still in flight.
- Review-run concurrency is capped separately from `max_parallel_sessions` so heavy task agents don't starve quick review summaries (and vice versa). Default cap: `max_parallel_reviews = 2`, new field on `OrchestratorConfig`. Same pid-reconcile pattern as `pollOnce` uses for tasks (`orchestrator-worker-runtime.ts:124-151`).
- `GET /api/reviews` becomes a pure read of `.cortex/reviews.json`. It does **not** shell out to `gh`. The frontend SWR-polls this cheap endpoint at 5s, just like `/api/tasks`.
- Manual **force-regenerate** is still synchronous (`POST /api/reviews/summarize`) — the user is in front of the page waiting; bypassing the worker keeps the latency tight. The endpoint reuses the same `spawnReviewSummary` and adds its pid to `activeReviewPids` so a worker tick fired mid-run won't double-spawn.
- Follow-up Q&A (`POST /api/reviews/followup`) also runs synchronously — user-initiated, short-lived, no worker involvement.

GitHub data: `gh search prs --review-requested=@me --state=open --json …` plus per-PR `gh pr view` calls to enrich with head SHA + mergeable state, parallelized.

**Session lifecycle:**
- Each summary run captures the session id (`session_id` on Claude's JSON result, `thread.started.thread_id` on Codex — same fields the existing runner reads in `agent-runner.ts:614,1221`) and stores it on the cached `ReviewSummary`.
- Initial generation and force-regenerate always run with **no resume** (fresh session). The new session id replaces the cached one.
- Follow-up questions run with **resume of the cached session_id** (`claude --resume <id> -p <question>` or `codex exec resume <id> <question>`, mirroring lines 484, 501–508 of `agent-runner.ts`). If resume fails (non-zero exit indicating session not found, or no `session_id` cached), fall back to a fresh session whose prompt is seeded with the cached summary text plus the question.
- Each follow-up exchange is appended to `ReviewSummary.followups[]` so the UI can show a transcript and stays robust across resume-fallbacks.

## Files to add

### 1. `src/lib/types.ts` (extend)
Add:
```ts
export interface ReviewRequest {
  pr_url: string;
  pr_number: number;
  repo_slug: string;        // "owner/repo"
  title: string;
  author: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  pr_status?: "clean" | "checks_failing" | "checks_pending" | "needs_approval"
            | "conflicts" | "unstable" | "unknown";
}

export interface ReviewSummary {
  pr_url: string;
  head_sha: string;                 // cache invalidation key
  summary: string;
  generated_at: string;
  runtime: AgentRuntime;
  effort?: TaskEffort;
  model?: string;
  session_id?: string;              // captured from runtime; used for follow-ups
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;                   // set if last attempt failed
  followups?: ReviewFollowup[];     // chronological Q&A on the summary
  final_at?: string;                // set when PR is observed merged/closed or
                                    // disappears from review-requested list; used for 24h GC
}

export interface ReviewFollowup {
  asked_at: string;
  question: string;
  answered_at: string;
  answer: string;
  session_id?: string;              // session that produced this answer (may differ if resume fell back)
  resumed: boolean;                 // false if we had to start fresh and re-seed the summary
  error?: string;
}
```

Extend `OrchestratorConfig`:
```ts
review_prompt?: string;             // editable in Settings; default seeded if absent
review_runtime?: AgentRuntime;      // default "claude"
review_effort?: TaskEffort;         // default per runtime
review_model?: string;              // optional override
max_parallel_reviews?: number;      // default 2; cap on worker-spawned review runs
```

### 2. `src/lib/github.ts` (extend)
Add `getReviewRequestedPRs()` — single `gh search prs` call, JSON-parsed; for each result run `gh pr view <url> --json headRefOid,state,mergeable,mergeableState` in parallel to enrich. Reuse the existing `getPRStatus()` helper rather than duplicating the mergeable-state logic.

```ts
export async function getReviewRequestedPRs(): Promise<ReviewRequest[]>
```

Add helpers for inline reviews (thin wrappers around `gh pr review`):
```ts
export async function submitPRReview(
  prUrl: string,
  decision: "approve" | "request-changes" | "comment",
  body: string
): Promise<{ ok: true } | { ok: false; error: string }>
```

### 3. `src/lib/review-store.ts` (new)
Mirrors the `tasks.json` pattern in `src/lib/store.ts` (line 56–113) using the same `withWriteLock` mutex. File: `.cortex/reviews.json`, shape `Record<pr_url, ReviewSummary>`. Functions: `readReviewSummaries()`, `getReviewSummary(prUrl)`, `upsertReviewSummary(...)`, `deleteReviewSummary(prUrl)`. Add `reviews.json` to the gitignore allowlist? — **no**, keep it tracked like `tasks.json` so cortex snapshots include it (matches existing pattern at `store.ts:7-17`).

### 4. `src/lib/review-runner.ts` (new)
The one-shot summarizer + follow-up runner. Not a worktree, not a task. Two surfaces:

1. **`spawnReviewSummary(prUrl, headSha, opts, onComplete)`** — non-blocking spawn modeled on `spawnAgentSession` in `agent-runner.ts:430`. Returns `{ pid, child }`. Used by the worker (which holds `activeReviewPids`) and by the synchronous `POST /api/reviews/summarize` endpoint (which awaits completion via a promise wrapper around the same spawn). On completion, persists the `ReviewSummary` to `.cortex/reviews.json` and invokes `onComplete`.
2. **`summarizePR(prUrl, headSha, opts)`** — thin Promise-returning wrapper around `spawnReviewSummary` for the manual force-regenerate API path.

```ts
export async function summarizePR(prUrl: string, headSha: string,
  opts: { runtime: AgentRuntime; effort?: TaskEffort; model?: string }
): Promise<ReviewSummary> {
  const config = readConfig();
  const prompt = `${config.review_prompt ?? DEFAULT_REVIEW_PROMPT}\n\nReview this PR: ${prUrl}`;
  // Fresh session — no --resume. Capture session_id from output and persist.
}

export async function askFollowup(
  prUrl: string,
  question: string
): Promise<ReviewFollowup> {
  const cached = await getReviewSummary(prUrl);
  if (!cached) throw new Error("No summary to follow up on; generate one first.");

  // Try 1: resume the cached session.
  if (cached.session_id) {
    const result = await runResumed(cached.runtime, cached.session_id, question, cached);
    if (result.ok) {
      return { asked_at, question, answered_at, answer: result.stdout,
               session_id: result.session_id ?? cached.session_id,
               resumed: true };
    }
    // fall through to fresh-session fallback
  }

  // Try 2: fresh session seeded with the prior summary as context.
  const seededPrompt = [
    "You previously produced the following review summary for this PR:",
    "<summary>",
    cached.summary,
    "</summary>",
    "",
    "The user is asking a follow-up question. Use only the summary plus any tools you have to answer.",
    "",
    `Question: ${question}`,
  ].join("\n");
  const fresh = await runFresh(cached.runtime, seededPrompt, cached);
  return { asked_at, question, answered_at, answer: fresh.stdout,
           session_id: fresh.session_id, resumed: false };
}
```

Runtime details:
- **Claude fresh:** `claude -p <prompt> --permission-mode bypassPermissions [--model …] [--effort …] --output-format json` — parse JSON, take `result` as summary and `session_id` for follow-ups.
- **Claude resume:** `claude --resume <session_id> -p <question> --output-format json …`. Detect a "session not found" / non-zero exit and trigger fallback.
- **Codex fresh:** `codex exec --json --dangerously-bypass-approvals-and-sandbox [-c model_reasoning_effort=…] [--model …] <prompt>` — read the JSONL event stream the way `handleCodexEvent` does in `agent-runner.ts:606-618`; pull `thread_id` off `thread.started`.
- **Codex resume:** `codex exec resume <session_id> <question> …` (same arg pattern as `agent-runner.ts:484,501-505`). Fall back on non-zero exit.
- Run from `process.cwd()` (cortex-city root). No worktree, no per-agent env file — only the global `.env`.
- 5-minute hard timeout for summaries and follow-ups. On error, return a `ReviewSummary` / `ReviewFollowup` with `error` populated so the UI surfaces it.

Extraction note: `buildEnv` (agent-runner.ts:67), `buildPermissionArgs` (line 168), and `buildModelArgs` (line 181) should be **exported** from `agent-runner.ts` (or pulled into a small `src/lib/runtime-args.ts`) and reused — do not duplicate the runtime CLI conventions.

### 5. `src/app/api/reviews/route.ts` (new)
- `GET` — pure read of `.cortex/reviews.json`. No `gh` shell-outs. Returns the cached entries (request fields + summary fields + followups) as an array. The worker is responsible for refreshing this file every poll cycle.

### 6. `src/app/api/reviews/summarize/route.ts` (new)
- `POST { pr_url, force?: boolean }` — only used for the manual **Regenerate** button (worker handles auto-summarize). If `force`, invokes `summarizePR()`, persists, and returns the new `ReviewSummary`. `head_sha` is read from the cached entry, so the client doesn't need to know it. The endpoint registers its pid in `activeReviewPids` (shared in-process map) so a worker tick fired mid-run doesn't double-spawn.

### 7. `src/app/api/reviews/submit/route.ts` (new)
- `POST { pr_url, decision: "approve" | "request-changes" | "comment", body: string }` — wraps `submitPRReview()`. Returns `{ ok, error? }`.

### 7b. `src/app/api/reviews/followup/route.ts` (new)
- `POST { pr_url, question }` — calls `askFollowup()`, persists the result into `ReviewSummary.followups[]` via `upsertReviewSummary`, returns the new `ReviewFollowup` (including whether the resume worked or fell back). Synchronous wait — a single follow-up runs in seconds.
- `GET ?pr_url=…` — returns the cached `followups[]` so the UI can hydrate the conversation on page load.

### 8. `src/app/reviews/page.tsx` (new)
SWR-polled (5 s) table that mirrors the visual conventions of `src/app/page.tsx`:

Columns: Repo · PR # · Title (link to PR) · Author · PR status badge (reuses the status palette from `page.tsx:39-44`) · Summary (truncated, click-to-expand) · Actions.

Behavior:
- Read-only consumer of `.cortex/reviews.json` via `GET /api/reviews`. No client-side summary triggering — when a PR has no summary, the row shows a "Summarizing…" placeholder and the worker fills it in on the next tick (≤ poll_interval_seconds). SHA-stale rows show "Outdated — refreshing…" with the same expectation.
- Row actions:
  - **Open PR** — `<a href={pr_url} target=_blank>`.
  - **Regenerate** — `POST /api/reviews/summarize` with `force: true` (always starts a fresh session, replaces `session_id`, clears `followups[]` since they belonged to the previous summary).
  - **Ask follow-up** — opens an expanding panel below the row showing the conversation transcript (`summary` as the first turn, then each `followup` Q/A). A textarea at the bottom posts to `POST /api/reviews/followup`. A subtle indicator shows whether the last turn resumed the original session or fell back to a fresh one.
  - **Review menu** — dropdown → Approve / Request changes / Comment → opens a small textarea modal → `POST /api/reviews/submit`. On success, refresh.
- Per-row override of runtime/effort via a small inline picker (defaults pulled from `OrchestratorConfig.review_runtime` / `review_effort`). The picker is *only* used when starting a fresh session (initial summary or regenerate); follow-ups always inherit the cached `runtime` so resume semantics stay consistent.

### 9. `src/app/layout.tsx` (edit)
Insert one line at `src/app/layout.tsx:64` (between Sessions and Settings):
```tsx
<NavLink href="/reviews">Reviews</NavLink>
```

### 10. `src/app/settings/page.tsx` (edit) + `src/app/api/config/route.ts`
Add a "Reviews" section to the settings page with three controls:
- Textarea: **Review prompt** (binds to `config.review_prompt`).
- Select: **Default runtime** (`claude` | `codex`).
- Select: **Default effort** (options depend on runtime, matching the per-task picker that already exists).

Server-side: `PUT /api/config` already exists; just make sure the new fields round-trip. Seed a sensible `DEFAULT_REVIEW_PROMPT` in `readConfig()` if absent.

## Files to read before editing
- `src/lib/store.ts` (mutex + JSON-file pattern to copy)
- `src/lib/agent-runner.ts` lines 67–80 (`buildEnv`), 168–201 (`buildPermissionArgs`, `buildModelArgs`) — extract & export
- `src/lib/github.ts` (full — extend with new functions)
- `src/app/page.tsx` (UI conventions, status palette, SWR pattern)
- `src/app/layout.tsx` (nav)
- `src/app/settings/page.tsx` + `src/app/api/config/route.ts` (settings round-trip)
- `src/lib/runtime-config.ts` (model/effort defaults — already imported by agent-runner)

## Caching & freshness rules
- Cache key: `pr_url`. Freshness check: `cached.head_sha === current.head_sha`.
- Stale entries are kept on disk; the UI shows "Outdated — refreshing…" while the worker re-summarizes on its next tick. When the SHA changes, `session_id` and `followups[]` are cleared (the previous review session was discussing a different commit set).
- No time-based TTL for fresh PRs; SHA invalidation is sufficient (per user's choice).

## Worker phases (new — covers polling, auto-summarize, and GC)

Matches the existing `PRUNE_AGE_MS` pattern at `src/lib/orchestrator-worker-runtime.ts:15` and `pollOnce`'s "scan in_review tasks" / "prune old final tasks" phases (lines 212–223 and 293–346).

Add three phases to `pollOnce` in `src/lib/orchestrator-worker-runtime.ts`. They run after the existing task phases. Pseudocode:

```ts
// Phase A: reconcile review-run pids (mirrors lines 124-151 for tasks).
for (const [prUrl, pid] of activeReviewPids) {
  if (!deps.isPidRunning(pid)) activeReviewPids.delete(prUrl);
}

// Phase B: refresh review requests + auto-trigger summaries.
deps.logger.log("[worker] Poll phase: scan review requests");
const openReviewRequests = await deps.getReviewRequestedPRs();
const cache = readReviewSummaries();

// Upsert request fields for every open PR; clear stale summary+session on SHA change.
for (const pr of openReviewRequests) {
  const cached = cache[pr.pr_url];
  if (!cached) {
    await upsertReviewSummary({ ...prFieldsOnly(pr) });  // summary not yet generated
  } else if (cached.head_sha !== pr.head_sha) {
    await upsertReviewSummary({
      ...cached, ...prFieldsOnly(pr),
      summary: "", session_id: undefined, followups: [], generated_at: "",
    });
  } else if (cached.pr_status !== pr.pr_status) {
    await upsertReviewSummary({ ...cached, pr_status: pr.pr_status });
  }
}

// Spawn summary runs, respecting max_parallel_reviews.
let reviewSlots = (config.max_parallel_reviews ?? 2) - activeReviewPids.size;
for (const pr of openReviewRequests) {
  if (reviewSlots <= 0) break;
  if (activeReviewPids.has(pr.pr_url)) continue;
  const cached = readReviewSummaries()[pr.pr_url];
  const needsSummary = !cached?.summary || cached.head_sha !== pr.head_sha;
  if (!needsSummary) continue;
  const { pid } = await spawnReviewSummary(pr.pr_url, pr.head_sha, configDefaults, () => {
    activeReviewPids.delete(pr.pr_url);
  });
  activeReviewPids.set(pr.pr_url, pid);
  reviewSlots--;
}

// Phase C: GC closed/removed PRs (24h after going final).
deps.logger.log("[worker] Poll phase: prune old reviews");
const openSet = new Set(openReviewRequests.map(r => r.pr_url));
const now = Date.now();
for (const review of Object.values(readReviewSummaries())) {
  if (activeReviewPids.has(review.pr_url)) continue;
  if (!review.final_at && !openSet.has(review.pr_url)) {
    await upsertReviewSummary({ ...review, final_at: new Date().toISOString() });
  }
  if (review.final_at && now - new Date(review.final_at).getTime() > PRUNE_AGE_MS) {
    await deleteReviewSummary(review.pr_url);
  }
}
```

Notes:
- `activeReviewPids` lives alongside `activePids` in the worker module (same in-memory map style used at `orchestrator-worker.ts`).
- Thread `getReviewRequestedPRs`, `spawnReviewSummary`, `readReviewSummaries`, `upsertReviewSummary`, `deleteReviewSummary` through `WorkerRuntimeDeps` (lines 40-71) so `orchestrator-worker-runtime.test.ts` can keep stubbing.
- Follow-ups are synchronous (single HTTP request) — they're either complete or errored long before GC runs, so we don't gate deletion on them.
- The manual `POST /api/reviews/summarize` endpoint should import the same `activeReviewPids` map (export it from the worker module) to coordinate with the worker.

## Out of scope (explicitly)
- Team review requests (only individual `review-requested:@me`).
- Showing closed/merged PRs in the list (they're held only for 24h after going final, then GC'd).
- "Deep review" with cortex agent worktrees — single shared review prompt only, per user's choice.
- Creating a cortex task from a Review row (the user did not select this).
- Background pre-warming summaries before the user opens the page.
- Multi-turn follow-ups inside a *single* HTTP call — each follow-up is one request/response cycle. The conversation is the durable transcript on disk.

## Verification

1. **Setup**: `gh auth status` must show an authenticated user. Confirm `claude` and `codex` CLIs are on PATH (already required by the app).
2. **Navigation**: `npm run dev`, open `http://localhost:3000`, confirm "Reviews" nav link appears between Sessions and Settings.
3. **Listing**:
   - From a separate clone, push a branch and open a PR that requests `@<your-gh-username>` as reviewer.
   - Refresh `/reviews`; the PR should appear within ~5 s.
4. **Summary (worker-driven)**:
   - On first sight, the row appears with a "Summarizing…" placeholder. Within one worker tick (`poll_interval_seconds`, default 30 s), the worker logs `[worker] Poll phase: scan review requests` and a `[worker] Spawning review summary for <pr_url>`.
   - Verify `.cortex/reviews.json` contains the entry with `summary` + `head_sha` + `session_id` populated.
   - Push a new commit to the PR; within one poll cycle the row should re-summarize (different `head_sha`, follow-ups cleared).
   - Click **Regenerate** — confirm a fresh `generated_at` timestamp and new tokens count, and that the worker's next tick does *not* double-spawn (only one run logged, `activeReviewPids` reflects the in-flight pid).
5. **Inline review**:
   - Click **Comment**, type a body, submit → confirm the comment appears on GitHub.
   - Repeat for **Approve** and **Request changes** on a test PR.
6. **Follow-up Q&A (session reuse)**:
   - After a summary is generated, open the follow-up panel and ask a question. Confirm the answer arrives, the UI shows "resumed" indicator, and `.cortex/reviews.json` now has a `followups[]` entry with `resumed: true`.
   - Manually corrupt the cached `session_id` (or wait until claude/codex GCs the session): ask another follow-up; confirm answer still arrives, indicator shows "fresh session", entry has `resumed: false`.
   - Force-regenerate the summary; confirm `session_id` changes and `followups[]` is cleared.
7. **Settings round-trip**:
   - Edit review prompt, runtime, effort in `/settings`, reload — values persist.
   - Generated summaries should reflect the new prompt content.
8. **Garbage collection (24h)** & worker concurrency:
   - Close (or merge) one of the test PRs. Within one worker poll cycle, confirm `.cortex/reviews.json` entry now has `final_at` set, and the PR drops out of the UI list.
   - Manually edit `final_at` in `.cortex/reviews.json` to a timestamp > 24h ago. After the next worker poll, confirm the entry is deleted from the file.
   - Set `max_parallel_reviews: 1` in `.cortex/config.json` with 3 PRs needing summaries; confirm only one review run is spawned per tick and the other two stay in "Summarizing…" until slots free up.
9. **Failure path**:
   - Stub `claude` to exit non-zero (or pass an invalid model); confirm the row shows the error string instead of stalling.
10. **No regressions**:
   - Existing Tasks / Agents / Sessions pages still render and function.
   - `.cortex/tasks.json` is unchanged after Reviews flows.
   - The existing task prune phase still runs and is unaffected by the new review prune phase (check worker logs for both phases each tick).
