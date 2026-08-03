# Review Non-Convergence Assessment

Assessment of a report from an implementation agent claiming Cortex City never enters a
bounded verification mode after its initial review, causing endless adversarial review
rounds. Evidence drawn from `marqo-ai/cloud_control_plane#4646` and the Cortex City
codebase as of `0bc6deb`.

## TL;DR

The report is accurate on every claim, and the root cause is clear: **convergence is
delegated entirely to the model's per-round judgment — there is no machine-enforced
stopping rule anywhere in the system**. Review state does exist (GitHub threads, plus CLI
session resume), and at current HEAD the reviewer demonstrably read it — its findings
cite prior threads and their resolution status by exact head SHA. It still didn't
converge, because each individual finding is locally justified against the fresh delta,
and nothing outside the model — no round counter, budget, findings ledger, or sticky
terminal state — can say "stop, escalate." The failures split into two problems: the
**indefinite looping** (a termination defect in the control flow) and the **reviewer's
inefficiency** (a cost defect in per-round behavior), coupled but not reducible to each
other. The proposed solution (semantic dedup, persistent state, discovery/verification
modes, materiality thresholds, convergence policy) targets the right gaps — most of it
maps onto mechanisms the codebase already half-has — and its parts are categorized
against those two problems under Recommendations below.

The PR outlived several reviewer-taming changes to Cortex City itself, so the evidence
below is bucketed against the Cortex commit history and conclusions rest only on
post-improvement behavior. The non-convergence is reproduced at current HEAD (`0bc6deb`,
#94): 9 new findings in the final 47 minutes before merge, including a reopened issue
family and 4 findings posted minutes after the builder's "final bounded convergence
review" request.

## Version alignment

Cortex City changed while PR #4646 was alive. Finding timestamps (UTC) bucketed against
commit boundaries:

| Cortex era | Window (UTC) | Top-level findings |
|---|---|---|
| pre-#84 (before delta-focused follow-ups) | until Jul 17 06:25 | 42 |
| #84 → #92 (delta focus, scope gates #89–#91) | Jul 17 06:25 – Jul 28 06:47 | 0 (PR dormant) |
| #92 → #93 (scope-expansion fix live) | Jul 28 06:47 – Jul 29 05:53 | 1 |
| #93 → #94 | Jul 29 05:53 – Jul 30 05:04 | 22 |
| #94 = current HEAD `0bc6deb` | Jul 30 05:04 – merge 06:49 | 9 |

The 42 pre-#84 findings are discounted throughout — they predate the follow-up-delta
prompt entirely. All 32 Jul 29–30 findings post-date #92 ("Prevent scope-expanding review
requests"), the last reviewer-behavior change before that window (#93 suppresses
duplicate follow-up tasks; #94 adds stacked-PR support — neither touches review
convergence).

Caveat: these are commit timestamps, not deployment timestamps. The orchestrator worker
picks up changes on restart, so a comment shortly after a commit could still come from an
older running version; the 22+9 findings sit hours past the #92/#93 boundaries, so the
attribution is safe for the conclusions drawn here. Code analysis was done at HEAD.

## Evidence from PR #4646 (post-improvement behavior only)

- Overall scale, for context: 610 review submissions, 601 inline comments, ~100 commits,
  74 top-level Cortex findings, ended only by a manual merge on 2026-07-30 with Cortex
  still mid-discovery.
- **At current HEAD (#94), the whack-a-mole loop is intact.** In the final 47 minutes: a
  finding explicitly reopening a family ("The prior username finding is only partially
  addressed" — the fix bounded `with`, so the same bypass was re-reported via `on` /
  `beside`), the `Shipping To:` vs misspelled `shiping` inflection, and — after the
  builder's 05:47 "final bounded convergence review" request — 4 more P1/P2 findings at
  05:51 (alphabetic user-ID values, person names consumed by the `lanyard`/`border`
  exemption, the missing `appears` relation, Markdown formatting).
- **In the #93 era (Jul 29–30, 22 findings), roughly a dozen P1s were variants of one
  root cause** — "the regex PII deny-list misses a neighboring phrasing":
  `jane doe (partially obscured)`, `jane doe **** 4242`, `jane doe / john smith`,
  `geometric logo jane doe`, `...in the corner jane doe`, `Jane Doe printed below`,
  `Brown box for gift wrapping for Jane Doe`. Each fix was met with the adjacent bypass
  as a new P1 blocker.
- The implementation agent explicitly requested convergence repeatedly ("final status
  request", "bounded convergence review", "final bounded convergence review" — the last
  two post-#94), asking Cortex to "conclude this exact-head review with **ready for human
  review**". Cortex never emitted that verdict once, in any era.
- The "**Human decision needed:** multilingual privacy grammar" comment was posted five
  times in the #93 era (00:38, 01:05, 01:12, 04:29, 04:46) before a human answered at
  04:49 deferring it to a follow-up PR. Nothing in #94 or at HEAD adds decision memory
  (see below), so this failure mode is unfixed even though the observed repeats predate
  HEAD by hours.
- **What the taming changes did and didn't fix**: the post-#92 findings largely comply
  with #90/#92's letter — they are delta-scoped, in-scope, smallest-fix, with exact
  reproductions on the exact head, and scope-expanding remedy demands are gone. But the
  finding *rate* did not drop (42 in the two pre-#84 days vs 32 in the two post-#92
  days). The scope gates worked as designed; scope was never the failure mode here —
  the absence of an enforced stopping rule is.
- **Memory was not the binding constraint.** The current-HEAD findings cite prior threads
  and their resolution status explicitly ("Follow-up after the earlier thread was
  resolved: exact head 75365bb...", "The prior username finding is only partially
  addressed on exact head 78614aa..."). The reviewer had the history and still posted the
  neighboring variant — proof that convergence cannot be left to the model's per-round
  judgment regardless of how much context it holds.

## Where the behavior comes from in the code

### 1. "Verification mode" is a prompt suggestion, not an enforced mode

The only difference between an initial and follow-up review is a prompt block in
`src/lib/review-runner.ts:653-676` saying "verify whether your previous findings were
addressed." The reviewer does have access to prior state — the base prompt directs it to
use `gh` for PR inspection (`review-runner.ts:171,178`), prior reviewer comments are
framed as evidence to re-evaluate (`review-runner.ts:558-587`), and CLI session resume
(`review-runner.ts:1119-1122`) restores the full prior conversation when it works. At
current HEAD it demonstrably used that state: findings cite earlier threads and their
resolution status by exact head SHA. But consumption is best-effort and unverified —
`buildReviewWrapperPrompt` never injects the previous findings, session resume requires
an intact `session_id` and identical model/runtime/effort config (wiped on any context
change: `orchestrator-worker-runtime.ts:1674-1677`, `1717-1720`), and PR #84 (`7c6ea2e`)
removed the explicit instruction to inspect prior agent-authored comments and threads.
More fundamentally, even a round that reads everything is still free — and implicitly
encouraged — to hunt the fresh delta for anything new. Nothing distinguishes "verify the
fix" from "review whatever moved" in a way the system can check.

### 2. The verdict is the only state, so per-head facts and cross-head facts share one lifetime

`orchestrator-worker-runtime.ts:1665-1687` clears `agent_review_status` whenever the head
SHA moves, and the scheduling gate (`orchestrator-worker-runtime.ts:1768-1778`) runs a
review whenever the stored summary isn't at the current head. Clearing the verdict per
commit is correct in itself — "is this head clean?" is genuinely per-head. The defect is
that the verdict is the *only* review state, so facts with a longer natural lifetime have
nowhere else to live and are destroyed with it. "We have asked the human to decide X and
are awaiting an answer" is a fact about the review conversation, not about a head: it
stays true across commits until answered. Because it exists only as
`agent_review_status: "needs_human_decision"` on one head, every unrelated push — and the
builder was landing fixes for *other* finding families throughout that window — erased
it, and the next round re-derived and re-posted the same question (00:38, 01:05, 01:12,
04:29, 04:46). The same conflation applies to `ready_for_human_approval`: "no material
issues remain as of round N" has meaning beyond one SHA, but cannot outlive it.
Compounding this, human answers have no durable home either: `my_approval_sha` /
`my_changes_requested_sha` are stripped for task-owned PRs (`review-store.ts:178-197`),
and `needs_human_decision` parks only the *builder* (only `needs_author_changes` resumes
it, `orchestrator-worker-runtime.ts:1785-1804`), not the reviewer. The codebase already
solves this exact shape elsewhere: `task.stack_decision_requested` is a
fingerprint-scoped "already surfaced to the human, don't re-raise" flag that survives
polls independent of per-head state — the review side has no analogue.

### 3. No findings ledger, no round counter, no budget

There is no structured representation of findings at all — `ReviewSummary`
(`src/lib/types.ts:347-387`) holds only a free-text summary, head SHAs, session info, and
comment receipts for the two handoff comments. Nothing can detect "this is the twelfth
finding in the same family" because families don't exist as data. An exhaustive search
for round/iteration/budget limits found none; the only numeric controls are review
concurrency (`max_parallel_reviews`) and error-retry backoff.

### 4. The loop is self-fueling

Reviewer-authored finding comments aren't receipted, so they mutate the PR state hash
(`github.ts:427-501`; only the two handoff comments are filtered via
`github.ts:105-112`), which wakes the builder
(`orchestrator-worker-runtime.ts:1369-1377`), which pushes a commit, which clears the
verdict, which schedules another review. Scheduling is driven entirely by head-SHA
movement.

The builder's escalating "bounded convergence review" / "final status request" comments
deserve a precise reading. Ignoring them as *authority* is correct — the builder is the
audited party and must not be able to end its own review. But they are a symptom that
**no party has a convergence channel**: the builder's declarations are rightly ignored,
the reviewer's clean verdict cannot survive the next push, and human answers are not
persisted for task-owned PRs. The only terminal event in the system is merge/close, so
the sole way a human can end a review is to bypass it — which is how #4646 ended. Those
comments also carried a legitimate, currently unparsed input: a fix manifest ("every
posted thread has been addressed; this batch closes X, Y, Z"). In a sound protocol that
is the builder's proper role — *claim* fixed per finding — with the reviewer verifying or
refuting each claim and the orchestrator deciding termination by policy. Nothing ties
those claims to finding identities today, which is the same missing-ledger gap as
everything else.

### Isn't GitHub the state?

A fair objection: PR state lives on GitHub — every finding, reply, resolution, and human
decision is in the threads, and the agent can and does fetch them. Three reasons this
doesn't produce convergence:

1. **GitHub is a transcript, not operative state.** It stores instances: comments
   anchored to file/lines, thread resolution toggled by whoever clicks it (here, the
   builder resolving threads it addressed). It has no representation of issue *family*,
   per-family round counts, "a human already decided X" as a suppressing fact, or a
   review budget. Enforcing "N rounds per family, then escalate" would require the
   reviewer to reconstruct families from 600+ comments and count rounds itself, correctly,
   every round — an unverified LLM judgment call.
2. **The control flow never reads it.** Scheduling triggers on head movement
   (`orchestrator-worker-runtime.ts:1768-1778`), the verdict is cleared without consuming
   a single comment (`:1678`), and the builder wakes on a state-hash delta. Every
   convergence-relevant decision the *system* makes is blind to thread content.
3. **Empirically, memory did not help.** The current-HEAD findings prove the reviewer
   read the threads and knew their resolution status — and posted the neighboring variant
   anyway, because each finding is locally justified against the fresh delta. A faithful
   delta-reviewer with perfect memory still never says "stop"; the stopping rule has to
   live outside the model.

## Two problems, one shared root

The findings above split into two distinct failure modes:

1. **Indefinite looping** — a *termination* problem, living in the control flow. The
   system has no computable notion of "done": no stopping rule, no round budget, no
   decision memory, and no state structured enough to build any of those on. Signature:
   families reopened via neighboring variants, the five-times-asked human decision,
   `ready_for_human_approval` never emitted, review ended only by manual merge.
2. **Reviewer inefficiency** — a *cost* problem, living mostly in per-round reviewer
   behavior. Two components: *rounds-to-converge* (findings dribbled one example per
   round instead of a root invariant with siblings tested up front — the 74 findings on
   #4646 plausibly collapse to six to eight family-level findings, and every extra round
   costs a review session, a builder wake, a commit, and CI) and *cost-per-round* (every
   follow-up runs at full adversarial initial-review depth instead of as a cheap
   verification pass scoped to fix claims, plus context reconstruction when resume
   breaks, plus unreceipted reviewer comments waking the builder for non-blocking
   content).

They are coupled: the inefficiency fuels the loop (one finding per round guarantees a
fresh fix-commit and a fresh delta every time), and the loop makes the inefficiency
unbounded in cost. The hinge is severity calibration — each marginal variant labeled a
P1 *blocker* is simultaneously what forces another round and what makes the spend look
justified. But neither problem subsumes the other: a hard stop rule alone leaves the
reviewer wasteful and truncates coverage (the genuine regressions found in late rounds
would simply go unfound), while efficiency fixes alone shrink the loop without
guaranteeing it ends.

## Recommendations

The five mechanisms the report asks for are the right ones, and the recent prompt-only
fixes (#84, #90, #92) show that prompt engineering alone hasn't been enough — this needs
state. Organized by which problem each fix addresses:

### Foundation (serves both problems)

- **Structured findings ledger with family identity** — the single highest-leverage
  change. Store findings in `ReviewSummary` as records (ID, root-cause invariant, family
  key, status: open / resolved / withdrawn / accepted-by-human), and inject the open
  ones into every follow-up prompt. Its value is not primarily memory — the reviewer
  already reads the threads — but enforcement substrate: family identity is what lets
  the *orchestrator* count rounds, detect variant churn, and apply a stopping rule,
  instead of hoping the model reconstructs families from 600 comments and stops itself
  (termination). It is equally what enables dedup, family-batched reporting, and
  claim-scoped verification (efficiency). It also makes verification robust when session
  resume fails, and gives the builder's fix claims an anchor: the builder marks findings
  as addressed by ID, and the follow-up review verifies exactly those claims rather than
  free-reading the delta.

  *Who assigns the family?* An LLM must — membership is semantic, and no syntactic key
  survives a root cause that moved across 20 lines. The reviewer already groups variants
  correctly in prose; the ledger makes that judgment binding: it proposes an assignment
  against the visible family list at finding creation, a *new* family (not membership)
  is the claim requiring justification, and ties break toward merging — a wrong merge
  still surfaces in the family's escalation summary, while a wrong new family mints a
  fresh budget. The orchestrator only enforces recorded assignments; disputes and splits
  escalate to the human, whose ruling sticks.

### Problem 1 — ending the loop (termination)

- **Sticky decisions and acknowledgements.** The codebase already has the exact pattern
  needed: `stack_decision_requested` is a fingerprint-scoped "we already asked the human
  about this" flag (`orchestrator-worker-runtime.ts:1255-1260`). Reuse it per
  finding-family: once `needs_human_decision` is raised for a family, never re-raise it;
  once a human answers, persist the acceptance and suppress the family permanently. This
  also requires splitting pending-decision state out of the per-head verdict (see root
  cause 2): the verdict may stay per-head, but "decision X requested / answered" must
  survive commits.
- **A convergence policy keyed to families, not just rounds.** A flat round budget would
  be crude; the better rule: after round 1, new *blockers* require either a materially
  distinct root cause or a regression introduced by the latest fix. After N rounds
  (e.g. 3) of new variants within one family, the family auto-converts to a single
  `needs_human_decision` / residual-risk summary. This preserves genuine findings — and
  that matters, because some of Cortex's July 30 findings were real regressions the
  narrow fixes introduced (e.g. `Brown box for gift wrapping for Jane Doe.` passing
  unchanged after an exemption was added). Those must stay blocking under any budget.

### Problem 2 — cutting review cost (efficiency)

- **Root-invariant initial reports.** Prompt change: report the invariant plus sibling
  cases as one finding, not one example. Cheap, directly attacks rounds-to-converge, and
  seeds the family structure the ledger needs.
- **A real verification mode for follow-ups.** Follow-up rounds should verify the
  builder's fix claims per finding ID at bounded depth, with new discovery limited to
  the delta and gated by the new-blocker bar above — not re-run open-ended adversarial
  discovery at initial-review depth. This attacks cost-per-round; today "verification"
  is a prompt suggestion with nothing enforcing it (root cause 1).
- **Receipt reviewer finding comments** so they stop churning the PR state hash and
  waking the builder for non-blocking content — removes wasted builder runs cheaply,
  and incidentally removes loop fuel.
- **Tiered reviewer.** Follow-up wake-ups run a cheap-model tier-1 round: a fresh
  session (no transcript resume — replay was the dominant measured cost) seeded with
  pointers only (open findings + repros, builder claims, last-reviewed→current SHAs);
  it pulls diff/code itself with full access. Verdict space is `verified`/`escalate`
  only — the orchestrator refuses terminal verdicts from tier 1, and budget overflow
  auto-escalates. The full-model tier 2 runs the initial review, escalations, and the
  final ready-for-human pass.

## The two-agent pathology

One observation the report undersells: this was a *two-agent* pathology. Cortex was
locally right almost every time — the builder kept patching example-by-example with
ever-narrower regex branches, and each patch genuinely had an adjacent bypass or
introduced a regression. The systemic failure is that nobody was positioned to say "regex
deny-listing of free-form language has an unbounded bypass surface; this is a design
decision, not a bug queue." The ideal behavior was a single `needs_human_decision` around
round two — Cortex even *has* that status and eventually used it (the multilingual
comment), but with no memory it had asked and no family tracking, it couldn't stop. A
round-budget alone won't fix the next PR like this; family-level escalation to a human is
the piece that actually breaks the loop.

## Agreed next steps

1. **Prompt-only convergence rule first** (no ledger yet): track finding families
   in-prompt, cap variants per family at x, then `needs_human_decision` and stop. Watch
   for the predicted failure modes — decisions re-asked after a resume break, families
   redefined to dodge the cap, stopped families reopening — before adding persistence
   (findings field + orchestrator guards).
2. **Root-invariant initial reports** (same prompt block): report the broken rule with
   tested sibling cases as one finding, not one example per round.
3. **Prompt-only verification follow-ups**: verify open findings by identity; new
   blockers only for a distinct root cause or a fix-introduced regression.
4. **Receipt reviewer finding comments**: extend the existing receipts mechanism so
   reviewer comments stop churning the PR state hash and waking Cortex-owned builders.
   (For external builders, the lever is fewer, better-batched comments — item 2.)
   Minor lever on #4646 itself; the big unnecessary-run class is reviewer-side (item 7).
5. **Tier-1 verification rounds**: follow-ups run on a cheap model in a fresh session,
   seeded with pointers (open findings, claims, SHA pair), pulling code/diff itself;
   verdicts limited to `verified`/`escalate`, terminal verdicts and the final pass
   reserved for the full-model tier 2. Kills the transcript-replay tax that dominated
   measured cost. High priority fleet-wide: the reviewer is a major quota consumer
   (~3× the local machine's raw input on the Jul 29 snapshot).
6. **Fresh sessions for all scheduled reviews** (resume kept only for interactive Q&A,
   where gaps are short and cache is warm). Measured on #4646: resume saved nothing —
   round gaps leave the cache 20–100% cold, and compaction makes the carried memory
   lossy anyway. Fresh-per-round is the already-exercised fallback path, so code risk
   is low. Caveat: without injected state, fresh rounds review blind — so this lands
   *together with* item 1's prompt-state. Mitigations: inject the stored summary,
   restore the inspect-prior-reviewer-comments instruction removed in #84, and later
   seed the findings ledger (item 5's pointers).
7. **Schedule reviews on effective diff, not head SHA**: hash the `base...head` patch
   (`git patch-id`); rebases that don't change the effective diff skip review, and
   stack reviews debounce until branch heads have been stable for a few minutes.
   Evidence: heavy silent re-review churn while the stack was publicly dormant
   (e.g. 1,543 reviewer calls on Jul 22, ~180M raw input, ~zero posted output) —
   stack rebases move every child head SHA, and head SHA is today's only scheduling
   signal. Largest measurable class of unnecessary runs.
   Caveat: the reviewer must still participate in conversation without a code change
   (today comment-only activity never wakes it at all). Two trigger classes: diff
   changed → review/verification round; new comments by others, no diff change
   (item 4's receipts distinguish this) → a lightweight reply round scoped to
   existing threads — no re-review, no new findings, escalate if something material
   surfaces.
