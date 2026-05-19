import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GITHUB_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/github.ts")
).href;

interface FakeGhResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "github-reviews-test-"));
}

function writeFakeGh(workspace: string) {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, "gh");
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("fs");

const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES_FILE, "utf8"));
const key = process.argv.slice(2).join(" ");
if (process.env.FAKE_GH_CALLS_FILE) {
  appendFileSync(process.env.FAKE_GH_CALLS_FILE, key + "\\n");
}
const response = responses[key];

if (!response) {
  process.stderr.write("No fake gh response for: " + key);
  process.exit(1);
}

if (response.stderr) process.stderr.write(response.stderr);
if (response.exitCode) process.exit(response.exitCode);
process.stdout.write(response.stdout || "");
`
  );
  chmodSync(binaryPath, 0o755);
}

function runGhScript(
  workspace: string,
  imports: string,
  responses: Record<string, FakeGhResponse>,
  body: string,
  options: { recordCalls?: boolean } = {}
): { result: unknown; calls: string[] } {
  const responsesFile = path.join(workspace, "gh-responses.json");
  writeFileSync(responsesFile, JSON.stringify(responses, null, 2));
  const callsFile = options.recordCalls
    ? path.join(workspace, "gh-calls.txt")
    : "";

  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        imports,
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
        ...(callsFile ? { FAKE_GH_CALLS_FILE: callsFile } : {}),
      },
    }
  );

  const lastLine = output.trim().split(/\r?\n/).pop()!;
  const result = JSON.parse(lastLine);
  let calls: string[] = [];
  if (callsFile && existsSync(callsFile)) {
    calls = readFileSync(callsFile, "utf8").split(/\r?\n/).filter(Boolean);
  }
  return { result, calls };
}

function setupWorkspace(): string {
  const workspace = createTempWorkspace();
  writeFakeGh(workspace);
  return workspace;
}

const SEARCH_KEY =
  "search prs user-review-requested:@me draft:false --state=open --json url,number,title,repository,author,createdAt,updatedAt --limit 200";

test("getReviewRequestedPRs uses user-review-requested + draft:false and enriches with head SHA", () => {
  const workspace = setupWorkspace();
  const searchResults = [
    {
      url: "https://github.com/acme/widget/pull/1",
      number: 1,
      title: "Add fizzbuzz",
      repository: { nameWithOwner: "acme/widget" },
      author: { login: "octocat" },
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
    {
      url: "https://github.com/acme/widget/pull/2",
      number: 2,
      title: "Tweak buttons",
      repository: { nameWithOwner: "acme/widget" },
      author: { login: "monalisa" },
      createdAt: "2026-05-02T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
    },
  ];
  const responses: Record<string, FakeGhResponse> = {
    [SEARCH_KEY]: { stdout: JSON.stringify(searchResults) },
    "pr view https://github.com/acme/widget/pull/1 --json headRefOid": {
      stdout: JSON.stringify({ headRefOid: "abc123" }),
    },
    "pr view https://github.com/acme/widget/pull/2 --json headRefOid": {
      stdout: JSON.stringify({ headRefOid: "def456" }),
    },
  };

  const { result, calls } = runGhScript(
    workspace,
    `import { getReviewRequestedPRs } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const prs = await getReviewRequestedPRs();
      console.log(JSON.stringify(prs));
    `,
    { recordCalls: true }
  );

  const prs = result as Array<{ pr_url: string; head_sha: string }>;
  assert.equal(prs.length, 2);
  assert.equal(prs[0].pr_url, "https://github.com/acme/widget/pull/1");
  assert.equal(prs[0].head_sha, "abc123");
  assert.equal(prs[1].head_sha, "def456");
  assert.equal(calls.includes(SEARCH_KEY), true);
});

test("getReviewRequestedPRs drops entries missing a head SHA", () => {
  const workspace = setupWorkspace();
  const searchResults = [
    {
      url: "https://github.com/acme/widget/pull/1",
      number: 1,
      title: "Add fizzbuzz",
      repository: { nameWithOwner: "acme/widget" },
      author: { login: "octocat" },
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ];
  const responses: Record<string, FakeGhResponse> = {
    [SEARCH_KEY]: { stdout: JSON.stringify(searchResults) },
    "pr view https://github.com/acme/widget/pull/1 --json headRefOid": {
      stdout: JSON.stringify({}),
    },
  };

  const { result } = runGhScript(
    workspace,
    `import { getReviewRequestedPRs } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const prs = await getReviewRequestedPRs();
      console.log(JSON.stringify(prs));
    `
  );
  assert.deepEqual(result, []);
});

test("getReviewRequestedPRs returns [] when the search response is empty", () => {
  const workspace = setupWorkspace();
  const responses: Record<string, FakeGhResponse> = {
    [SEARCH_KEY]: { stdout: "" },
  };

  const { result } = runGhScript(
    workspace,
    `import { getReviewRequestedPRs } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const prs = await getReviewRequestedPRs();
      console.log(JSON.stringify(prs));
    `
  );
  assert.deepEqual(result, []);
});

test("submitPRReview rejects request-changes / comment without a body", () => {
  const workspace = setupWorkspace();
  const { result } = runGhScript(
    workspace,
    `import { submitPRReview } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    {},
    `
      const result = await submitPRReview(
        "https://github.com/acme/widget/pull/1",
        "request-changes",
        "   "
      );
      console.log(JSON.stringify(result));
    `
  );
  assert.deepEqual(result, {
    ok: false,
    error: "A review body is required for this decision.",
  });
});

test("submitPRReview shells out with the expected flag + body", () => {
  const workspace = setupWorkspace();
  const responses: Record<string, FakeGhResponse> = {
    "pr review https://github.com/acme/widget/pull/1 --approve --body LGTM": {
      stdout: "ok",
    },
  };
  const { result, calls } = runGhScript(
    workspace,
    `import { submitPRReview } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const result = await submitPRReview(
        "https://github.com/acme/widget/pull/1",
        "approve",
        "LGTM"
      );
      console.log(JSON.stringify(result));
    `,
    { recordCalls: true }
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(
    calls.includes(
      "pr review https://github.com/acme/widget/pull/1 --approve --body LGTM"
    ),
    true
  );
});

test("submitPRReview surfaces gh failures", () => {
  const workspace = setupWorkspace();
  const responses: Record<string, FakeGhResponse> = {
    "pr review https://github.com/acme/widget/pull/1 --comment --body nope": {
      stderr: "permission denied",
      exitCode: 1,
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { submitPRReview } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const result = await submitPRReview(
        "https://github.com/acme/widget/pull/1",
        "comment",
        "nope"
      );
      console.log(JSON.stringify(result));
    `
  );
  assert.deepEqual(result, { ok: false, error: "permission denied" });
});

test("submitPRReview rejects unparseable PR URLs without touching gh", () => {
  const workspace = setupWorkspace();
  const { result } = runGhScript(
    workspace,
    `import { submitPRReview } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    {},
    `
      const result = await submitPRReview("not-a-url", "approve", "");
      console.log(JSON.stringify(result));
    `
  );
  assert.deepEqual(result, { ok: false, error: "Invalid PR URL" });
});

test("getReviewLifecycleState reports merged_closed for merged PRs", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr view ${prUrl} --json state,merged,latestReviews`]: {
      stdout: JSON.stringify({
        state: "MERGED",
        merged: true,
        latestReviews: [],
      }),
    },
    "api user --jq .login": { stdout: "me" },
  };
  const { result } = runGhScript(
    workspace,
    `import { getReviewLifecycleState } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await getReviewLifecycleState(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "merged_closed");
});

test("getReviewLifecycleState reports merged_closed for closed (not merged) PRs", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr view ${prUrl} --json state,merged,latestReviews`]: {
      stdout: JSON.stringify({
        state: "CLOSED",
        merged: false,
        latestReviews: [],
      }),
    },
    "api user --jq .login": { stdout: "me" },
  };
  const { result } = runGhScript(
    workspace,
    `import { getReviewLifecycleState } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await getReviewLifecycleState(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "merged_closed");
});

test("getReviewLifecycleState recognises my own approval as approved", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr view ${prUrl} --json state,merged,latestReviews`]: {
      stdout: JSON.stringify({
        state: "OPEN",
        merged: false,
        latestReviews: [
          { state: "APPROVED", author: { login: "octocat" } },
          { state: "APPROVED", author: { login: "me" } },
        ],
      }),
    },
    "api user --jq .login": { stdout: "me" },
  };
  const { result } = runGhScript(
    workspace,
    `import { getReviewLifecycleState } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await getReviewLifecycleState(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "approved");
});

test("getReviewLifecycleState ignores other reviewers' approvals", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr view ${prUrl} --json state,merged,latestReviews`]: {
      stdout: JSON.stringify({
        state: "OPEN",
        merged: false,
        latestReviews: [
          { state: "APPROVED", author: { login: "octocat" } },
          { state: "COMMENTED", author: { login: "me" } },
        ],
      }),
    },
    "api user --jq .login": { stdout: "me" },
  };
  const { result } = runGhScript(
    workspace,
    `import { getReviewLifecycleState } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await getReviewLifecycleState(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "needs_approval");
});
