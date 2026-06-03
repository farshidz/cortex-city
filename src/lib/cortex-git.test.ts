import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CORTEX_GIT_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/cortex-git.ts")
).href;
const EMPTY_WORKTREE_SCAN = {
  orphanedWorktreeCount: 0,
  orphanedWorktrees: [],
  worktreeScanErrors: [],
};

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cortex-git-test-"));
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createWorktree(worktreePath: string) {
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(worktreePath, ".git"), "gitdir: ../repo/.git/worktrees/test\n");
}

function runCortexGitScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as cortexGit from ${JSON.stringify(CORTEX_GIT_MODULE_URL)};`,
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

test("getCortexGitStatus reports disabled when .cortex is not a git repository", () => {
  const workspace = createTempWorkspace();

  const status = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify(cortexGit.getCortexGitStatus()));"
  );

  assert.deepEqual(status, {
    enabled: false,
    pushing: false,
    ...EMPTY_WORKTREE_SCAN,
  });
});

test("getCortexGitStatus reports enabled without pushing when the repo has no remote", () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: cortexDir });

  const status = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify(cortexGit.getCortexGitStatus()));"
  );

  assert.deepEqual(status, {
    enabled: true,
    pushing: false,
    ...EMPTY_WORKTREE_SCAN,
  });
});

test("getCortexGitStatus reports the configured remote when .cortex has one", () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: cortexDir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/farshidz/marqo-cortex-city.git"],
    { cwd: cortexDir }
  );

  const status = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify(cortexGit.getCortexGitStatus()));"
  );

  assert.deepEqual(status, {
    enabled: true,
    pushing: true,
    remoteName: "origin",
    remoteUrl: "https://github.com/farshidz/marqo-cortex-city.git",
    remoteSlug: "farshidz/marqo-cortex-city",
    ...EMPTY_WORKTREE_SCAN,
  });
});

test("getCortexGitStatus removes orphaned worktrees before reporting status", () => {
  const workspace = createTempWorkspace();
  const worktreesRoot = path.join(workspace, ".cortex/repos/acme-widget/.worktrees");
  const orphanedWorktree = path.join(worktreesRoot, "orphaned-task");
  createWorktree(orphanedWorktree);
  writeJson(path.join(workspace, ".cortex/tasks.json"), []);

  const status = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify(cortexGit.getCortexGitStatus()));"
  );

  assert.deepEqual(status, {
    enabled: false,
    pushing: false,
    ...EMPTY_WORKTREE_SCAN,
  });
  assert.equal(existsSync(orphanedWorktree), false);
});

test("recoverStaleCortexGitIndexLock removes an old git index lock", () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: cortexDir });

  const lockPath = path.join(cortexDir, ".git", "index.lock");
  writeFileSync(lockPath, "");
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lockPath, oldTime, oldTime);

  const result = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify({ recovered: cortexGit.recoverStaleCortexGitIndexLock() }));"
  );

  assert.deepEqual(result, { recovered: true });
  assert.equal(existsSync(lockPath), false);
});

test("recoverStaleCortexGitIndexLock leaves a fresh git index lock alone", () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: cortexDir });

  const lockPath = path.join(cortexDir, ".git", "index.lock");
  writeFileSync(lockPath, "");

  const result = runCortexGitScript(
    workspace,
    "console.log(JSON.stringify({ recovered: cortexGit.recoverStaleCortexGitIndexLock() }));"
  );

  assert.deepEqual(result, { recovered: false });
  assert.equal(existsSync(lockPath), true);
});
