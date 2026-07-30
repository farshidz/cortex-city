// In-process tests for the pure stacked-PR helpers shared by the agent
// runner, the worker, and the prompt builder.
import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateStackPRStatus,
  frontierStackedPR,
  isStackedTask,
  openStackedPRs,
  reconcileStackedPRs,
  stackClosedBaseFingerprint,
  stackEntriesOnClosedBase,
  stackEntriesRequiringRestack,
  stackRequiresRestack,
  stackTerminalStatus,
} from "./stacked-prs";
import type { TaskStackedPR } from "./types";

function entry(overrides: Partial<TaskStackedPR> = {}): TaskStackedPR {
  return {
    position: 1,
    pr_url: "https://github.com/acme/widget/pull/1",
    branch_name: "agent/slice",
    base_branch: "main",
    scope: "Slice one",
    state: "open",
    ...overrides,
  };
}

test("isStackedTask requires a non-empty stack", () => {
  assert.equal(isStackedTask({}), false);
  assert.equal(isStackedTask({ stacked_prs: [] }), false);
  assert.equal(isStackedTask({ stacked_prs: [entry()] }), true);
});

test("openStackedPRs sorts by position and filters terminal entries", () => {
  const stack = [
    entry({ position: 3, pr_url: "https://github.com/acme/widget/pull/3" }),
    entry({
      position: 1,
      pr_url: "https://github.com/acme/widget/pull/1",
      state: "merged",
    }),
    entry({ position: 2, pr_url: "https://github.com/acme/widget/pull/2" }),
  ];
  assert.deepEqual(
    openStackedPRs(stack).map((e) => e.position),
    [2, 3]
  );
  assert.equal(
    frontierStackedPR(stack)?.pr_url,
    "https://github.com/acme/widget/pull/2"
  );
  assert.equal(frontierStackedPR([entry({ state: "merged" })]), undefined);
});

test("aggregateStackPRStatus reports the worst open-entry status", () => {
  assert.equal(aggregateStackPRStatus([entry()]), undefined);
  assert.equal(
    aggregateStackPRStatus([
      entry({ pr_status: "clean" }),
      entry({
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        pr_status: "checks_failing",
      }),
      entry({
        position: 3,
        pr_url: "https://github.com/acme/widget/pull/3",
        state: "merged",
        pr_status: "conflicts",
      }),
    ]),
    "checks_failing"
  );
});

test("stack restack detection keys off merged base branches", () => {
  const healthy = [
    entry({ branch_name: "b1" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
    }),
  ];
  assert.equal(stackRequiresRestack(healthy), false);

  const mergedBelow = [
    entry({ branch_name: "b1", state: "merged" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
    }),
  ];
  assert.equal(stackRequiresRestack(mergedBelow), true);
  assert.deepEqual(
    stackEntriesRequiringRestack(mergedBelow).map((e) => e.position),
    [2]
  );

  // A retargeted entry no longer needs restacking even though a merged
  // entry exists in the stack.
  const retargeted = [
    entry({ branch_name: "b1", state: "merged" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "main",
    }),
  ];
  assert.equal(stackRequiresRestack(retargeted), false);
});

test("restacking a lower branch pulls every open entry above it into the set", () => {
  // b1 <- b2 <- b3: merging PR 1 rewrites b2, which invalidates b3's merge
  // base even though b3's own base (b2) is still open.
  const threeEntryStack = [
    entry({ branch_name: "b1", state: "merged" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
    }),
    entry({
      position: 3,
      pr_url: "https://github.com/acme/widget/pull/3",
      branch_name: "b3",
      base_branch: "b2",
    }),
  ];
  assert.deepEqual(
    stackEntriesRequiringRestack(threeEntryStack).map((e) => e.position),
    [2, 3]
  );
});

test("an unverified restack obligation keeps the restack required after retargeting", () => {
  const retargetedButUnverified = [
    entry({ branch_name: "b1", state: "merged", merge_commit_sha: "squash-1" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "main", // base label already points at main
      pending_restack_of: ["squash-1"],
    }),
  ];
  assert.equal(stackRequiresRestack(retargetedButUnverified), true);
  assert.deepEqual(
    stackEntriesRequiringRestack(retargetedButUnverified).map((e) => e.position),
    [2]
  );

  const verified = [
    entry({ branch_name: "b1", state: "merged", merge_commit_sha: "squash-1" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "main",
      pending_restack_of: undefined,
    }),
  ];
  assert.equal(stackRequiresRestack(verified), false);
});

test("stackClosedBaseFingerprint identifies the exact broken-stack condition", () => {
  assert.equal(stackClosedBaseFingerprint([entry()]), undefined);
  const broken = [
    entry({ branch_name: "b1", state: "closed" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
    }),
  ];
  const fingerprint = stackClosedBaseFingerprint(broken);
  assert.ok(fingerprint?.startsWith("closed_base:"));
  assert.ok(fingerprint?.includes("https://github.com/acme/widget/pull/2<-b1"));
  // A different closure produces a different fingerprint.
  const differentBroken = [
    entry({ branch_name: "b1", state: "closed" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/3",
      branch_name: "b3",
      base_branch: "b1",
    }),
  ];
  assert.notEqual(stackClosedBaseFingerprint(differentBroken), fingerprint);
});

test("a closed unmerged base is a broken stack, not a restack", () => {
  const closedBelow = [
    entry({ branch_name: "b1", state: "closed" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
    }),
  ];
  // The squash-merge restack protocol must never apply: the closed PR's
  // commits are not in any base branch, so dropping them would delete work.
  assert.equal(stackRequiresRestack(closedBelow), false);
  assert.deepEqual(
    stackEntriesOnClosedBase(closedBelow).map((e) => e.position),
    [2]
  );
  assert.deepEqual(stackEntriesOnClosedBase([entry()]), []);
});

test("stackTerminalStatus distinguishes fully merged from abandoned stacks", () => {
  assert.equal(stackTerminalStatus([]), undefined);
  assert.equal(stackTerminalStatus([entry()]), undefined);
  assert.equal(
    stackTerminalStatus([
      entry({ state: "merged" }),
      entry({
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        state: "merged",
      }),
    ]),
    "merged"
  );
  assert.equal(
    stackTerminalStatus([
      entry({ state: "merged" }),
      entry({
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        state: "closed",
      }),
    ]),
    "closed"
  );
});

test("reconcileStackedPRs returns undefined when nothing is stacked", () => {
  assert.equal(reconcileStackedPRs(undefined, undefined), undefined);
  assert.equal(reconcileStackedPRs([], null), undefined);
  assert.equal(reconcileStackedPRs(undefined, []), undefined);
});

test("reconcileStackedPRs seeds new entries as open", () => {
  const result = reconcileStackedPRs(undefined, [
    {
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
      scope: "Slice two",
    },
    {
      position: 1,
      pr_url: "https://github.com/acme/widget/pull/1",
      branch_name: "b1",
      base_branch: "main",
      scope: "Slice one",
    },
  ]);
  assert.ok(result);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.stack.map((e) => [e.position, e.state]),
    [
      [1, "open"],
      [2, "open"],
    ]
  );
});

test("reconcileStackedPRs preserves worker-owned fields and keeps dropped entries", () => {
  const current: TaskStackedPR[] = [
    entry({
      position: 1,
      pr_url: "https://github.com/acme/widget/pull/1",
      branch_name: "b1",
      state: "merged",
      merge_commit_sha: "squash-1",
    }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
      scope: "Original scope",
      pr_status: "clean",
      last_review_gh_state: "hash-2",
      pending_restack_of: ["squash-1"],
    }),
  ];
  const result = reconcileStackedPRs(current, [
    {
      position: 1,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "main", // restacked onto main after PR 1 merged
      scope: "",
    },
  ]);
  assert.ok(result);
  // PR 1 was omitted from the report but stays tracked with a warning.
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /dropped stack entry/);
  const kept = result.stack.find(
    (e) => e.pr_url === "https://github.com/acme/widget/pull/1"
  );
  assert.equal(kept?.state, "merged");
  const updated = result.stack.find(
    (e) => e.pr_url === "https://github.com/acme/widget/pull/2"
  );
  assert.equal(updated?.base_branch, "main");
  assert.equal(updated?.state, "open");
  assert.equal(updated?.pr_status, "clean");
  assert.equal(updated?.last_review_gh_state, "hash-2");
  // Worker-owned restack bookkeeping survives the report: the agent cannot
  // clear its own obligation by omitting it.
  assert.deepEqual(updated?.pending_restack_of, ["squash-1"]);
  assert.equal(kept?.merge_commit_sha, "squash-1");
  // Blank reported scope falls back to the tracked scope.
  assert.equal(updated?.scope, "Original scope");
});

test("reconcileStackedPRs keeps the tracked stack when the report omits it", () => {
  const current = [entry()];
  const result = reconcileStackedPRs(current, null);
  assert.ok(result);
  assert.equal(result.stack.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /omitted stacked_prs/);
});

test("reconcileStackedPRs rejects malformed reports atomically", () => {
  const validEntry = {
    position: 1,
    pr_url: "https://github.com/acme/widget/pull/1",
    branch_name: "b1",
    base_branch: "main",
    scope: "Slice one",
  };

  // A blank entry poisons the whole report: accepting only the valid part
  // would silently shrink the stack and orphan the real PR.
  const blankUrl = reconcileStackedPRs(undefined, [
    validEntry,
    { position: 2, pr_url: "  ", branch_name: "b2", base_branch: "b1", scope: "" },
  ]);
  assert.ok(blankUrl);
  assert.equal(blankUrl.stack.length, 0);
  assert.equal(blankUrl.warnings.length, 1);
  assert.match(blankUrl.warnings[0], /Rejected stacked_prs report/);

  // Non-canonical PR URLs are rejected.
  const badUrl = reconcileStackedPRs(undefined, [
    { ...validEntry, pr_url: "https://github.com/acme/widget/pulls" },
  ]);
  assert.ok(badUrl);
  assert.equal(badUrl.stack.length, 0);
  assert.match(badUrl.warnings[0], /not a canonical GitHub pull request URL/);

  // Duplicate URLs and duplicate or non-contiguous positions are rejected.
  const duplicateUrl = reconcileStackedPRs(undefined, [
    validEntry,
    { ...validEntry, position: 2, branch_name: "b1-dup" },
  ]);
  assert.ok(duplicateUrl);
  assert.equal(duplicateUrl.stack.length, 0);
  assert.match(duplicateUrl.warnings[0], /listed twice/);

  const gappedPositions = reconcileStackedPRs(undefined, [
    validEntry,
    {
      position: 3,
      pr_url: "https://github.com/acme/widget/pull/3",
      branch_name: "b3",
      base_branch: "b1",
      scope: "Slice three",
    },
  ]);
  assert.ok(gappedPositions);
  assert.equal(gappedPositions.stack.length, 0);
  assert.match(gappedPositions.warnings[0], /not contiguous/);

  // With a tracked stack, rejection preserves it unchanged.
  const tracked: TaskStackedPR[] = [
    entry({ state: "merged" }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
      last_review_gh_state: "hash-2",
    }),
  ];
  const preserved = reconcileStackedPRs(tracked, [
    { position: 1, pr_url: "not-a-url", branch_name: "b2", base_branch: "main", scope: "" },
  ]);
  assert.ok(preserved);
  assert.equal(preserved.stack.length, 2);
  assert.equal(preserved.stack[0].state, "merged");
  assert.equal(preserved.stack[1].last_review_gh_state, "hash-2");
  assert.match(preserved.warnings[0], /keeping the tracked stack unchanged/);
});
