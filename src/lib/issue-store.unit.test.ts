// In-process tests for issue-store exports. The store reads/writes
// .cortex/issues.json relative to process.cwd() (captured at import time),
// so tests track created issue ids and clean them up after running to avoid
// polluting the real cortex file when running from the repo root.
import test from "node:test";
import assert from "node:assert/strict";

import * as store from "./issue-store";
import type { Issue, Task } from "./types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-unit-" + Math.random().toString(36).slice(2),
    title: "task",
    description: "",
    agent: "a",
    status: "open",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

async function cleanup(ids: string[]) {
  for (const id of ids) {
    try {
      await store.unlinkTask(id, { keepTerminalStatus: false });
    } catch {
      /* ignore */
    }
    try {
      await store.deleteIssue(id);
    } catch {
      /* ignore */
    }
  }
}

test("issue-store namespace exports are all reachable", () => {
  assert.equal(typeof store.readIssues, "function");
  assert.equal(typeof store.getIssue, "function");
  assert.equal(typeof store.createIssue, "function");
  assert.equal(typeof store.updateIssue, "function");
  assert.equal(typeof store.deleteIssue, "function");
  assert.equal(typeof store.addComment, "function");
  assert.equal(typeof store.linkTask, "function");
  assert.equal(typeof store.unlinkTask, "function");
  assert.equal(typeof store.syncIssueFromTask, "function");
  assert.equal(typeof store.mapTaskStatusToIssueStatus, "function");
  assert.equal(typeof store.compareIssues, "function");
});

test("mapTaskStatusToIssueStatus maps all task statuses", () => {
  assert.equal(store.mapTaskStatusToIssueStatus("open"), "in_progress");
  assert.equal(store.mapTaskStatusToIssueStatus("in_progress"), "in_progress");
  assert.equal(store.mapTaskStatusToIssueStatus("in_review"), "in_progress");
  assert.equal(store.mapTaskStatusToIssueStatus("merged"), "done");
  assert.equal(store.mapTaskStatusToIssueStatus("closed"), "closed");
});

test("compareIssues orders by priority then updated_at, undefined priority last", () => {
  const mk = (priority: Issue["priority"], updated_at: string): Issue => ({
    id: `${priority ?? "none"}-${updated_at}`,
    title: "",
    description: "",
    status: "open",
    priority,
    comments: [],
    created_at: updated_at,
    updated_at,
  });
  const list = [
    mk(undefined, "2026-05-04T00:00:00Z"),
    mk("low", "2026-05-01T00:00:00Z"),
    mk("high", "2026-05-02T00:00:00Z"),
    mk("medium", "2026-05-03T00:00:00Z"),
    mk("high", "2026-05-03T00:00:00Z"),
    mk(undefined, "2026-05-05T00:00:00Z"),
  ];
  list.sort(store.compareIssues);
  assert.deepEqual(
    list.map((i) => i.id),
    [
      "high-2026-05-03T00:00:00Z",
      "high-2026-05-02T00:00:00Z",
      "medium-2026-05-03T00:00:00Z",
      "low-2026-05-01T00:00:00Z",
      "none-2026-05-05T00:00:00Z",
      "none-2026-05-04T00:00:00Z",
    ]
  );
});

test("create / get / update / comment / link / sync / unlink / delete roundtrip in-process", async () => {
  const created: string[] = [];
  try {
    const issue = await store.createIssue({
      title: "unit-roundtrip",
      description: "desc",
      plan: "## plan",
      priority: "medium",
    });
    created.push(issue.id);
    assert.equal(issue.title, "unit-roundtrip");
    assert.equal(issue.plan, "## plan");
    assert.equal(issue.priority, "medium");

    const fetched = await store.getIssue(issue.id);
    assert.equal(fetched?.id, issue.id);

    const updated = await store.updateIssue(issue.id, {
      title: "renamed",
      priority: "high",
    });
    assert.equal(updated.title, "renamed");
    assert.equal(updated.priority, "high");

    const cleared = await store.updateIssue(issue.id, { priority: null });
    assert.equal(cleared.priority, undefined);

    const comment = await store.addComment(issue.id, "hello");
    assert.equal(comment.body, "hello");
    const after = await store.getIssue(issue.id);
    assert.equal(after?.comments.length, 1);

    const linked = await store.linkTask(issue.id, "task-unit");
    assert.equal(linked.task_id, "task-unit");
    assert.equal(linked.status, "in_progress");

    await store.syncIssueFromTask(task({ id: "task-unit", issue_id: issue.id, status: "merged" }));
    const synced = await store.getIssue(issue.id);
    assert.equal(synced?.status, "done");

    const unlinked = await store.unlinkTask(issue.id, { keepTerminalStatus: true });
    assert.equal(unlinked?.status, "done");
    assert.equal(unlinked?.task_id, undefined);

    await store.deleteIssue(issue.id);
    const gone = await store.getIssue(issue.id);
    assert.equal(gone, undefined);
  } finally {
    await cleanup(created);
  }
});

test("createIssue normalizes invalid priority and getIssue returns undefined for missing ids", async () => {
  const created: string[] = [];
  try {
    const issue = await store.createIssue({
      title: "unit-bad-priority",
      description: "",
      // @ts-expect-error testing invalid value
      priority: "urgent",
    });
    created.push(issue.id);
    assert.equal(issue.priority, undefined);
    assert.equal(await store.getIssue("does-not-exist-id"), undefined);
  } finally {
    await cleanup(created);
  }
});

test("updateIssue / deleteIssue / addComment / linkTask throw for missing ids", async () => {
  await assert.rejects(() => store.updateIssue("missing-id-unit", { title: "x" }), /not found/);
  await assert.rejects(() => store.deleteIssue("missing-id-unit"), /not found/);
  await assert.rejects(() => store.addComment("missing-id-unit", "x"), /not found/);
  await assert.rejects(() => store.linkTask("missing-id-unit", "t1"), /not found/);
});

test("unlinkTask returns undefined for missing issues and is a no-op when not linked", async () => {
  const created: string[] = [];
  try {
    const missing = await store.unlinkTask("missing-id-unit", { keepTerminalStatus: false });
    assert.equal(missing, undefined);

    const issue = await store.createIssue({ title: "unit-unlink-noop", description: "" });
    created.push(issue.id);
    const result = await store.unlinkTask(issue.id, { keepTerminalStatus: false });
    assert.equal(result?.task_id, undefined);
    assert.equal(result?.status, "open");
  } finally {
    await cleanup(created);
  }
});

test("linkTask rejects when issue is already linked to a different task", async () => {
  const created: string[] = [];
  try {
    const issue = await store.createIssue({ title: "unit-link-conflict", description: "" });
    created.push(issue.id);
    await store.linkTask(issue.id, "task-a");
    await assert.rejects(() => store.linkTask(issue.id, "task-b"), /already linked/);
  } finally {
    await cleanup(created);
  }
});

test("syncIssueFromTask is a no-op when task has no issue_id or issue is missing or task is different", async () => {
  const created: string[] = [];
  try {
    // No issue_id at all.
    await store.syncIssueFromTask(task({ status: "merged" }));
    // issue_id pointing at a missing issue.
    await store.syncIssueFromTask(task({ issue_id: "missing-id-unit", status: "merged" }));

    const issue = await store.createIssue({ title: "unit-sync-other", description: "" });
    created.push(issue.id);
    await store.linkTask(issue.id, "task-a");

    // Sync from a different task should be ignored.
    await store.syncIssueFromTask(
      task({ id: "task-b", issue_id: issue.id, status: "merged" })
    );
    const after = await store.getIssue(issue.id);
    assert.equal(after?.task_id, "task-a");
    assert.equal(after?.status, "in_progress");
  } finally {
    await cleanup(created);
  }
});
