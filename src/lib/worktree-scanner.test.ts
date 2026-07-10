import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const WORKTREE_SCANNER_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/worktree-scanner.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "worktree-scanner-test-"));
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createWorktree(worktreePath: string) {
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(worktreePath, ".git"), "gitdir: ../repo/.git/worktrees/test\n");
}

function runWorktreeScannerScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as scanner from ${JSON.stringify(WORKTREE_SCANNER_MODULE_URL)};`,
        "(async () => {",
        body,
        "})().catch((error) => {",
        "  console.error(error);",
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

test("scanOrphanWorktrees reports unlinked managed worktrees", () => {
  const workspace = createTempWorkspace();
  const worktreesRoot = path.join(workspace, ".cortex/repos/acme-widget/.worktrees");
  const linkedWorktree = path.join(worktreesRoot, "linked-task");
  const orphanedWorktree = path.join(worktreesRoot, "orphaned-task");
  createWorktree(linkedWorktree);
  createWorktree(orphanedWorktree);
  mkdirSync(path.join(worktreesRoot, "not-a-worktree"), { recursive: true });
  writeJson(path.join(workspace, ".cortex/tasks.json"), [
    {
      id: "task-1",
      title: "Linked task",
      description: "",
      status: "in_review",
      agent: "agent",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      worktree_path: linkedWorktree,
    },
  ]);

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.scanOrphanWorktrees()));"
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.orphanedWorktrees, [
    { path: realpathSync(orphanedWorktree), root: realpathSync(worktreesRoot) },
  ]);
  assert.equal(result.linkedWorktreeCount, 1);
});

test("scanOrphanWorktrees scans legacy roots discovered from task paths", () => {
  const workspace = createTempWorkspace();
  const legacyRoot = path.join(workspace, "repos/.worktrees");
  const linkedWorktree = path.join(legacyRoot, "linked-legacy");
  const orphanedWorktree = path.join(legacyRoot, "orphaned-legacy");
  createWorktree(linkedWorktree);
  createWorktree(orphanedWorktree);
  writeJson(path.join(workspace, ".cortex/tasks.json"), [
    {
      id: "task-legacy",
      title: "Linked legacy task",
      description: "",
      status: "in_review",
      agent: "agent",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      worktree_path: linkedWorktree,
    },
  ]);

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.scanOrphanWorktrees()));"
  );

  assert.deepEqual(result.scannedRoots, [realpathSync(legacyRoot)]);
  assert.deepEqual(result.orphanedWorktrees, [
    { path: realpathSync(orphanedWorktree), root: realpathSync(legacyRoot) },
  ]);
});

test("scanOrphanWorktrees does not infer legacy roots from missing task paths", () => {
  const workspace = createTempWorkspace();
  const legacyRoot = path.join(workspace, "repos/.worktrees");
  const orphanedWorktree = path.join(legacyRoot, "orphaned-legacy");
  createWorktree(orphanedWorktree);
  writeJson(path.join(workspace, ".cortex/tasks.json"), [
    {
      id: "stale-final",
      title: "Stale final task",
      description: "",
      status: "merged",
      agent: "agent",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      worktree_path: path.join(legacyRoot, "missing-final"),
    },
  ]);

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.scanOrphanWorktrees()));"
  );

  assert.deepEqual(result.scannedRoots, []);
  assert.deepEqual(result.orphanedWorktrees, []);
  assert.equal(existsSync(orphanedWorktree), true);
});

test("scanOrphanWorktrees scans configured legacy roots", () => {
  const workspace = createTempWorkspace();
  const legacyRoot = path.join(workspace, "repos/.worktrees");
  const orphanedWorktree = path.join(legacyRoot, "orphaned-legacy");
  createWorktree(orphanedWorktree);
  writeJson(path.join(workspace, ".cortex/tasks.json"), []);
  writeJson(path.join(workspace, ".cortex/config.json"), {
    worktree_roots: [legacyRoot],
  });

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.scanOrphanWorktrees()));"
  );

  assert.deepEqual(result.scannedRoots, [realpathSync(legacyRoot)]);
  assert.deepEqual(result.orphanedWorktrees, [
    { path: realpathSync(orphanedWorktree), root: realpathSync(legacyRoot) },
  ]);
});

test("cleanupOrphanWorktrees removes unlinked managed worktrees", () => {
  const workspace = createTempWorkspace();
  const worktreesRoot = path.join(workspace, ".cortex/repos/acme-widget/.worktrees");
  const linkedWorktree = path.join(worktreesRoot, "linked-task");
  const orphanedWorktree = path.join(worktreesRoot, "orphaned-task");
  createWorktree(linkedWorktree);
  createWorktree(orphanedWorktree);
  const normalizedOrphan = realpathSync(orphanedWorktree);
  const normalizedRoot = realpathSync(worktreesRoot);
  writeJson(path.join(workspace, ".cortex/tasks.json"), [
    {
      id: "task-1",
      title: "Linked task",
      description: "",
      status: "in_review",
      agent: "agent",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      worktree_path: linkedWorktree,
    },
  ]);

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.cleanupOrphanWorktrees()));"
  );

  assert.deepEqual(result.cleanedWorktrees, [
    { path: normalizedOrphan, root: normalizedRoot },
  ]);
  assert.deepEqual(result.orphanedWorktrees, []);
  assert.equal(existsSync(orphanedWorktree), false);
  assert.equal(existsSync(linkedWorktree), true);
});

test("cleanupOrphanWorktrees preserves referenced in-review worktrees in legacy roots", () => {
  const workspace = createTempWorkspace();
  const legacyRoot = path.join(workspace, "repos/.worktrees");
  const linkedWorktree = path.join(legacyRoot, "linked-in-review");
  const orphanedWorktree = path.join(legacyRoot, "orphaned-legacy");
  createWorktree(linkedWorktree);
  createWorktree(orphanedWorktree);
  const normalizedOrphan = realpathSync(orphanedWorktree);
  const normalizedRoot = realpathSync(legacyRoot);
  writeJson(path.join(workspace, ".cortex/tasks.json"), [
    {
      id: "task-in-review",
      title: "In-review task",
      description: "",
      status: "in_review",
      agent: "agent",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      worktree_path: linkedWorktree,
    },
  ]);

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.cleanupOrphanWorktrees()));"
  );

  assert.deepEqual(result.cleanedWorktrees, [
    { path: normalizedOrphan, root: normalizedRoot },
  ]);
  assert.equal(existsSync(orphanedWorktree), false);
  assert.equal(existsSync(linkedWorktree), true);
});

test("cleanupOrphanWorktrees does not remove worktrees when tasks cannot be read", () => {
  const workspace = createTempWorkspace();
  const worktreesRoot = path.join(workspace, ".cortex/repos/acme-widget/.worktrees");
  const orphanedWorktree = path.join(worktreesRoot, "orphaned-task");
  createWorktree(orphanedWorktree);
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(path.join(workspace, ".cortex/tasks.json"), "{not json");

  const result = runWorktreeScannerScript(
    workspace,
    "console.log(JSON.stringify(scanner.cleanupOrphanWorktrees()));"
  );

  assert.deepEqual(result.cleanedWorktrees, []);
  assert.deepEqual(result.orphanedWorktrees, []);
  assert.equal(existsSync(orphanedWorktree), true);
  assert.ok(
    result.errors.some((error: string) => error.startsWith("Failed to read tasks:"))
  );
});
