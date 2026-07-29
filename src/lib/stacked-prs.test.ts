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

test("stack restack detection keys off terminal base branches", () => {
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
    }),
    entry({
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/2",
      branch_name: "b2",
      base_branch: "b1",
      scope: "Original scope",
      pr_status: "clean",
      last_review_gh_state: "hash-2",
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

test("reconcileStackedPRs skips duplicate and invalid reported entries", () => {
  const result = reconcileStackedPRs(undefined, [
    {
      position: 1,
      pr_url: "https://github.com/acme/widget/pull/1",
      branch_name: "b1",
      base_branch: "main",
      scope: "Slice one",
    },
    {
      position: 2,
      pr_url: "https://github.com/acme/widget/pull/1",
      branch_name: "b1-dup",
      base_branch: "main",
      scope: "Duplicate",
    },
    {
      position: 3,
      pr_url: "  ",
      branch_name: "b3",
      base_branch: "b2",
      scope: "Invalid",
    },
  ]);
  assert.ok(result);
  assert.equal(result.stack.length, 1);
  assert.equal(result.stack[0].branch_name, "b1");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /twice/);
});
