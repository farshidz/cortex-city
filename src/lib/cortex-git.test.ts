import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CORTEX_GIT_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/cortex-git.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cortex-git-test-"));
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
  });
});
