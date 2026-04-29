import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GITHUB_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/github.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "github-test-"));
}

function writeFakeGh(workspace: string) {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, "gh");
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const { readFileSync } = require("fs");

const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES_FILE, "utf8"));
const key = process.argv.slice(2).join(" ");
const response = responses[key];

if (!response) {
  process.stderr.write("No fake gh response for: " + key);
  process.exit(1);
}

if (response.stderr) {
  process.stderr.write(response.stderr);
}

if (response.exitCode) {
  process.exit(response.exitCode);
}

process.stdout.write(response.stdout || "");
`
  );
  chmodSync(binaryPath, 0o755);
}

function runGithubScript(
  workspace: string,
  responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
  body: string
) {
  const responsesFile = path.join(workspace, "gh-responses.json");
  writeFileSync(responsesFile, JSON.stringify(responses, null, 2));

  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { getPRStateHash, getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
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
      env: {
        ...process.env,
        PATH: `${path.join(workspace, "bin")}:${process.env.PATH || ""}`,
        FAKE_GH_RESPONSES_FILE: responsesFile,
      },
    }
  );

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function setupWorkspace(): string {
  const workspace = createTempWorkspace();
  writeFakeGh(workspace);
  return workspace;
}

function prViewKey(prUrl: string): string {
  return `pr view ${prUrl} --json headRefOid,statusCheckRollup`;
}

function reviewsKey(): string {
  return "api --paginate --slurp repos/acme/widget/pulls/123/reviews";
}

function reviewCommentsKey(): string {
  return "api --paginate --slurp repos/acme/widget/pulls/123/comments";
}

function issueCommentsKey(): string {
  return "api --paginate --slurp repos/acme/widget/issues/123/comments";
}

function checksKey(prUrl: string): string {
  return `pr checks ${prUrl} --json name,state --jq [.[] | .name + "=" + .state] | sort | join(",")`;
}

test("getPRStateHash keeps a stable hash when GitHub reports no checks", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [prViewKey(prUrl)]: {
      stdout: JSON.stringify({
        headRefOid: "abc123",
        statusCheckRollup: [],
      }),
    },
    [reviewsKey()]: { stdout: JSON.stringify([[]]) },
    [reviewCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [issueCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [checksKey(prUrl)]: {
      stderr: "no checks reported on the 'agent/test' branch",
      exitCode: 1,
    },
  };

  const hash = runGithubScript(
    workspace,
    responses,
    `
      const hash = await getPRStateHash(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(hash));
    `
  );

  const expected = createHash("sha256")
    .update("abc123|[]|[]|[]|")
    .digest("hex")
    .slice(0, 16);
  assert.equal(hash, expected);
});

test("getPRStateHash fails closed when a GitHub review fetch is throttled", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [prViewKey(prUrl)]: {
      stdout: JSON.stringify({
        headRefOid: "abc123",
        statusCheckRollup: [],
      }),
    },
    [reviewsKey()]: {
      stderr: "rate limit exceeded",
      exitCode: 1,
    },
    [reviewCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [issueCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [checksKey(prUrl)]: { stdout: "" },
  };

  const hash = runGithubScript(
    workspace,
    responses,
    `
      const hash = await getPRStateHash(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(hash));
    `
  );

  assert.equal(hash, "");
});

test("submitted comment tracking ignores pending inline review comments", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [reviewsKey()]: {
      stdout: JSON.stringify([
        [
          { id: 10, state: "APPROVED" },
          { id: 11, state: "PENDING" },
        ],
      ]),
    },
    [reviewCommentsKey()]: {
      stdout: JSON.stringify([
        [
          { id: 100, pull_request_review_id: 10 },
          { id: 101, pull_request_review_id: 11 },
          { id: 102, pull_request_review_id: null },
        ],
      ]),
    },
    [issueCommentsKey()]: {
      stdout: JSON.stringify([[{ id: 200 }]]),
    },
  };

  const ids = runGithubScript(
    workspace,
    responses,
    `
      const ids = await getSubmittedCommentIds(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(ids));
    `
  );

  assert.deepEqual(ids, [100, 200]);
});

test("getPRStateHash ignores pending inline review comments", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [prViewKey(prUrl)]: {
      stdout: JSON.stringify({
        headRefOid: "abc123",
        statusCheckRollup: [],
      }),
    },
    [reviewsKey()]: {
      stdout: JSON.stringify([
        [
          { id: 10, state: "COMMENTED" },
          { id: 11, state: "PENDING" },
        ],
      ]),
    },
    [reviewCommentsKey()]: {
      stdout: JSON.stringify([
        [
          { id: 100, pull_request_review_id: 10 },
          { id: 101, pull_request_review_id: 11 },
          { id: 102, pull_request_review_id: null },
        ],
      ]),
    },
    [issueCommentsKey()]: {
      stdout: JSON.stringify([[{ id: 200 }]]),
    },
    [checksKey(prUrl)]: { stdout: "" },
  };

  const hash = runGithubScript(
    workspace,
    responses,
    `
      const hash = await getPRStateHash(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(hash));
    `
  );

  const expected = createHash("sha256")
    .update('abc123|[100]|[200]|[{"id":10,"state":"COMMENTED"}]|')
    .digest("hex")
    .slice(0, 16);
  assert.equal(hash, expected);
});
