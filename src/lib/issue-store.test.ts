import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const STORE_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/issue-store.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "issue-store-test-"));
}

function runScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as store from ${JSON.stringify(STORE_MODULE_URL)};`,
        "(async () => {",
        body,
        "})().catch((error) => {",
        '  console.error(error);',
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
    }
  );

  return JSON.parse(output);
}

test("createIssue persists with defaults and writes to .cortex/issues.json", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "Bug 1", description: "Broken" });
      console.log(JSON.stringify(issue));
    `
  );
  assert.equal(result.title, "Bug 1");
  assert.equal(result.description, "Broken");
  assert.equal(result.status, "open");
  assert.deepEqual(result.comments, []);
  assert.equal(typeof result.id, "string");
  const file = path.join(workspace, ".cortex", "issues.json");
  assert.equal(existsSync(file), true);
  const persisted = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, result.id);
});

test("updateIssue patches fields and refreshes updated_at", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const created = await store.createIssue({ title: "T", description: "D" });
      const updated = await store.updateIssue(created.id, {
        title: "T2",
        status: "in_progress",
        plan: "do it",
      });
      console.log(JSON.stringify({ created, updated }));
    `
  );
  assert.equal(result.updated.title, "T2");
  assert.equal(result.updated.status, "in_progress");
  assert.equal(result.updated.plan, "do it");
  assert.notEqual(result.updated.updated_at, result.created.updated_at);
});

test("addComment appends with timestamp and bumps issue updated_at", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "T", description: "D" });
      const c1 = await store.addComment(issue.id, "First");
      const c2 = await store.addComment(issue.id, "Second");
      const issues = store.readIssues();
      console.log(JSON.stringify({ issue, c1, c2, after: issues[0] }));
    `
  );
  assert.equal(result.c1.body, "First");
  assert.equal(result.c2.body, "Second");
  assert.equal(result.after.comments.length, 2);
  assert.equal(result.after.comments[0].id, result.c1.id);
  assert.equal(result.after.comments[1].id, result.c2.id);
  assert.notEqual(result.after.updated_at, result.issue.updated_at);
});

test("linkTask sets task_id and flips status to in_progress", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "T", description: "D" });
      const linked = await store.linkTask(issue.id, "task-abc");
      console.log(JSON.stringify(linked));
    `
  );
  assert.equal(result.task_id, "task-abc");
  assert.equal(result.status, "in_progress");
});

test("linkTask rejects when issue is already linked to a different task", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "T", description: "D" });
      await store.linkTask(issue.id, "task-a");
      let error;
      try {
        await store.linkTask(issue.id, "task-b");
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      console.log(JSON.stringify({ error }));
    `
  );
  assert.match(result.error, /already linked/);
});

test("unlinkTask resets to open by default, preserves terminal status when requested", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue1 = await store.createIssue({ title: "A", description: "" });
      await store.linkTask(issue1.id, "t1");
      await store.updateIssue(issue1.id, { status: "done" });
      const kept = await store.unlinkTask(issue1.id, { keepTerminalStatus: true });

      const issue2 = await store.createIssue({ title: "B", description: "" });
      await store.linkTask(issue2.id, "t2");
      const reopened = await store.unlinkTask(issue2.id, { keepTerminalStatus: false });

      console.log(JSON.stringify({ kept, reopened }));
    `
  );
  assert.equal(result.kept.status, "done");
  assert.equal(result.kept.task_id, undefined);
  assert.equal(result.reopened.status, "open");
  assert.equal(result.reopened.task_id, undefined);
});

test("syncIssueFromTask maps task statuses to issue statuses", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const baseTask = {
        id: "t1",
        title: "x",
        description: "",
        agent: "a",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      };
      const issue = await store.createIssue({ title: "I", description: "" });
      await store.linkTask(issue.id, "t1");

      const results = {};
      for (const status of ["open", "in_progress", "in_review", "merged", "closed"]) {
        await store.syncIssueFromTask({ ...baseTask, status, issue_id: issue.id });
        const current = store.readIssues()[0];
        results[status] = current.status;
      }
      console.log(JSON.stringify(results));
    `
  );
  assert.deepEqual(result, {
    open: "in_progress",
    in_progress: "in_progress",
    in_review: "in_progress",
    merged: "done",
    closed: "closed",
  });
});

test("syncIssueFromTask is a no-op when issue is linked to a different task", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "I", description: "" });
      await store.linkTask(issue.id, "t1");
      await store.syncIssueFromTask({
        id: "t2",
        title: "other",
        description: "",
        agent: "a",
        status: "merged",
        issue_id: issue.id,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      });
      console.log(JSON.stringify(store.readIssues()[0]));
    `
  );
  assert.equal(result.status, "in_progress");
  assert.equal(result.task_id, "t1");
});

test("createIssue accepts and persists priority; invalid values normalize to undefined", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const high = await store.createIssue({ title: "H", description: "", priority: "high" });
      const bogus = await store.createIssue({ title: "B", description: "", priority: "urgent" });
      const none = await store.createIssue({ title: "N", description: "" });
      console.log(JSON.stringify({ high, bogus, none }));
    `
  );
  assert.equal(result.high.priority, "high");
  assert.equal(result.bogus.priority, undefined);
  assert.equal(result.none.priority, undefined);
});

test("updateIssue sets, changes, and clears priority", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const issue = await store.createIssue({ title: "T", description: "" });
      const set = await store.updateIssue(issue.id, { priority: "medium" });
      const raised = await store.updateIssue(issue.id, { priority: "high" });
      const cleared = await store.updateIssue(issue.id, { priority: null });
      console.log(JSON.stringify({ set, raised, cleared }));
    `
  );
  assert.equal(result.set.priority, "medium");
  assert.equal(result.raised.priority, "high");
  assert.equal(result.cleared.priority, undefined);
});

test("compareIssues sorts by priority desc, then updated_at desc, undefined last", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const mkIssue = (priority, updated_at) => ({
        id: priority + "-" + updated_at,
        title: "",
        description: "",
        status: "open",
        priority,
        comments: [],
        created_at: updated_at,
        updated_at,
      });
      const list = [
        mkIssue(undefined, "2026-05-04T00:00:00Z"),
        mkIssue("low", "2026-05-01T00:00:00Z"),
        mkIssue("high", "2026-05-02T00:00:00Z"),
        mkIssue("medium", "2026-05-03T00:00:00Z"),
        mkIssue("high", "2026-05-03T00:00:00Z"),
        mkIssue(undefined, "2026-05-05T00:00:00Z"),
      ];
      list.sort(store.compareIssues);
      console.log(JSON.stringify(list.map((i) => i.id)));
    `
  );
  assert.deepEqual(result, [
    "high-2026-05-03T00:00:00Z",
    "high-2026-05-02T00:00:00Z",
    "medium-2026-05-03T00:00:00Z",
    "low-2026-05-01T00:00:00Z",
    "undefined-2026-05-05T00:00:00Z",
    "undefined-2026-05-04T00:00:00Z",
  ]);
});

test("deleteIssue removes the issue from disk", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const a = await store.createIssue({ title: "A", description: "" });
      const b = await store.createIssue({ title: "B", description: "" });
      await store.deleteIssue(a.id);
      console.log(JSON.stringify(store.readIssues()));
    `
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "B");
});

test("getIssue returns the issue when found and undefined otherwise", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const created = await store.createIssue({ title: "Find me", description: "" });
      const hit = await store.getIssue(created.id);
      const miss = await store.getIssue("nope");
      console.log(JSON.stringify({ hit, miss: miss ?? null }));
    `
  );
  assert.equal(result.hit.title, "Find me");
  assert.equal(result.miss, null);
});

test("updateIssue throws when issue is missing and deleteIssue rejects missing ids", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      let updateError;
      try {
        await store.updateIssue("missing", { title: "x" });
      } catch (e) {
        updateError = e instanceof Error ? e.message : String(e);
      }
      let deleteError;
      try {
        await store.deleteIssue("missing");
      } catch (e) {
        deleteError = e instanceof Error ? e.message : String(e);
      }
      console.log(JSON.stringify({ updateError, deleteError }));
    `
  );
  assert.match(result.updateError, /not found/);
  assert.match(result.deleteError, /not found/);
});

test("addComment throws when issue is missing", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      let err;
      try {
        await store.addComment("missing", "hi");
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      console.log(JSON.stringify({ err }));
    `
  );
  assert.match(result.err, /not found/);
});

test("linkTask throws when issue is missing and is a no-op when re-linking same task", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      let missingErr;
      try {
        await store.linkTask("missing", "t1");
      } catch (e) {
        missingErr = e instanceof Error ? e.message : String(e);
      }
      const issue = await store.createIssue({ title: "T", description: "" });
      await store.linkTask(issue.id, "t1");
      const again = await store.linkTask(issue.id, "t1");
      console.log(JSON.stringify({ missingErr, again }));
    `
  );
  assert.match(result.missingErr, /not found/);
  assert.equal(result.again.task_id, "t1");
  assert.equal(result.again.status, "in_progress");
});

test("unlinkTask returns undefined for missing issues and returns issue untouched when not linked", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const missing = await store.unlinkTask("missing", { keepTerminalStatus: false });
      const issue = await store.createIssue({ title: "T", description: "" });
      const unlinked = await store.unlinkTask(issue.id, { keepTerminalStatus: false });
      console.log(JSON.stringify({ missing: missing ?? null, unlinked }));
    `
  );
  assert.equal(result.missing, null);
  assert.equal(result.unlinked.task_id, undefined);
  assert.equal(result.unlinked.status, "open");
});

test("syncIssueFromTask is a no-op when task has no issue_id or issue is missing", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const baseTask = {
        id: "t1",
        title: "",
        description: "",
        agent: "a",
        status: "merged",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      };
      await store.syncIssueFromTask({ ...baseTask });
      await store.syncIssueFromTask({ ...baseTask, issue_id: "missing" });
      const issue = await store.createIssue({ title: "I", description: "" });
      await store.linkTask(issue.id, "t1");
      await store.syncIssueFromTask({ ...baseTask, id: "t1", issue_id: issue.id, status: "in_progress" });
      const after = store.readIssues()[0];
      console.log(JSON.stringify({ after }));
    `
  );
  assert.equal(result.after.status, "in_progress");
});

test("mapTaskStatusToIssueStatus exposes the task-to-issue status mapping", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      console.log(JSON.stringify({
        open: store.mapTaskStatusToIssueStatus("open"),
        in_progress: store.mapTaskStatusToIssueStatus("in_progress"),
        in_review: store.mapTaskStatusToIssueStatus("in_review"),
        merged: store.mapTaskStatusToIssueStatus("merged"),
        closed: store.mapTaskStatusToIssueStatus("closed"),
      }));
    `
  );
  assert.deepEqual(result, {
    open: "in_progress",
    in_progress: "in_progress",
    in_review: "in_progress",
    merged: "done",
    closed: "closed",
  });
});

test("readIssues returns [] for missing, non-array, and unparseable issues.json", () => {
  const workspace = createTempWorkspace();
  const result = runScript(
    workspace,
    `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = path.join(process.cwd(), ".cortex");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "issues.json");

      const empty = store.readIssues();
      fs.writeFileSync(file, "not json");
      const broken = store.readIssues();
      fs.writeFileSync(file, JSON.stringify({ not: "array" }));
      const wrongShape = store.readIssues();
      console.log(JSON.stringify({ empty, broken, wrongShape }));
    `
  );
  assert.deepEqual(result.empty, []);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.wrongShape, []);
});
