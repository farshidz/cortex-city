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
