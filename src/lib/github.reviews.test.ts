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
  "search prs user-review-requested:@me draft:false --archived=false --state=open --json url,number,title,repository,author,createdAt,updatedAt --limit 200";
const REVIEWED_SEARCH_KEY =
  "search prs reviewed-by:me draft:false --archived=false --state=open --json url,number,title,repository,author,createdAt,updatedAt --limit 200";

test("getReviewRequestedPRs unions requested and reviewed PRs, then enriches with head SHA + my_last_review_sha", () => {
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
  const reviewedResults = [
    searchResults[0],
    {
      url: "https://github.com/acme/widget/pull/3",
      number: 3,
      title: "Keep reviewed PR visible",
      repository: { nameWithOwner: "acme/widget" },
      author: { login: "hubot" },
      createdAt: "2026-05-03T00:00:00Z",
      updatedAt: "2026-05-03T00:00:00Z",
    },
    {
      url: "https://github.com/acme/widget/pull/4",
      number: 4,
      title: "Do not list my own PR",
      repository: { nameWithOwner: "acme/widget" },
      author: { login: "me" },
      createdAt: "2026-05-04T00:00:00Z",
      updatedAt: "2026-05-04T00:00:00Z",
    },
  ];
  const responses: Record<string, FakeGhResponse> = {
    [SEARCH_KEY]: { stdout: JSON.stringify(searchResults) },
    [REVIEWED_SEARCH_KEY]: { stdout: JSON.stringify(reviewedResults) },
    "api user --jq .login": { stdout: "me" },
    "pr view https://github.com/acme/widget/pull/1 --json headRefOid": {
      stdout: JSON.stringify({ headRefOid: "abc123" }),
    },
    "pr view https://github.com/acme/widget/pull/2 --json headRefOid": {
      stdout: JSON.stringify({ headRefOid: "def456" }),
    },
    "pr view https://github.com/acme/widget/pull/3 --json headRefOid": {
      stdout: JSON.stringify({ headRefOid: "ghi789" }),
    },
    "api --paginate --slurp repos/acme/widget/pulls/1/reviews": {
      stdout: JSON.stringify([
        [
          {
            user: { login: "me" },
            commit_id: "earlier-sha",
            state: "COMMENTED",
            submitted_at: "2026-04-30T00:00:00Z",
          },
          {
            user: { login: "me" },
            commit_id: "abc123",
            state: "APPROVED",
            submitted_at: "2026-05-01T00:00:00Z",
          },
          {
            user: { login: "octocat" },
            commit_id: "irrelevant",
            state: "APPROVED",
            submitted_at: "2026-05-02T00:00:00Z",
          },
        ],
      ]),
    },
    "api --paginate --slurp repos/acme/widget/pulls/2/reviews": {
      stdout: JSON.stringify([[]]),
    },
    "api --paginate --slurp repos/acme/widget/pulls/3/reviews": {
      stdout: JSON.stringify([
        [
          {
            user: { login: "me" },
            commit_id: "ghi789",
            state: "COMMENTED",
            submitted_at: "2026-05-03T00:00:00Z",
          },
        ],
      ]),
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

  const prs = result as Array<{
    pr_url: string;
    head_sha: string;
    my_last_review_sha?: string;
  }>;
  assert.equal(prs.length, 3);
  assert.equal(prs[0].pr_url, "https://github.com/acme/widget/pull/1");
  assert.equal(prs[0].head_sha, "abc123");
  // PR #1: my latest non-pending review is at abc123 (matches head — "up to date").
  assert.equal(prs[0].my_last_review_sha, "abc123");
  // PR #2: I have never reviewed.
  assert.equal(prs[1].my_last_review_sha, undefined);
  // PR #3: I already reviewed it, so it stays visible after GitHub clears the request.
  assert.equal(prs[2].pr_url, "https://github.com/acme/widget/pull/3");
  assert.equal(prs[2].my_last_review_sha, "ghi789");
  assert.equal(
    prs.some((pr) => pr.pr_url === "https://github.com/acme/widget/pull/4"),
    false
  );
  assert.equal(calls.includes(SEARCH_KEY), true);
  assert.equal(calls.includes(REVIEWED_SEARCH_KEY), true);
  assert.equal(
    calls.includes("pr view https://github.com/acme/widget/pull/4 --json headRefOid"),
    false
  );
});

test("getMyLastReviewSha returns undefined when login is empty or no reviews match", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    "api --paginate --slurp repos/acme/widget/pulls/1/reviews": {
      stdout: JSON.stringify([
        [
          {
            user: { login: "octocat" },
            commit_id: "abc",
            state: "APPROVED",
            submitted_at: "2026-05-01T00:00:00Z",
          },
        ],
      ]),
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { getMyLastReviewSha } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const noLogin = await getMyLastReviewSha(${JSON.stringify(prUrl)}, "");
      const noMatch = await getMyLastReviewSha(${JSON.stringify(prUrl)}, "me");
      console.log(JSON.stringify({ noLogin: noLogin ?? null, noMatch: noMatch ?? null }));
    `
  );
  assert.equal((result as { noLogin: unknown }).noLogin, null);
  assert.equal((result as { noMatch: unknown }).noMatch, null);
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
    [REVIEWED_SEARCH_KEY]: { stdout: JSON.stringify([]) },
    "api user --jq .login": { stdout: "me" },
    "pr view https://github.com/acme/widget/pull/1 --json headRefOid": {
      stdout: JSON.stringify({}),
    },
    "api --paginate --slurp repos/acme/widget/pulls/1/reviews": {
      stdout: JSON.stringify([[]]),
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
    [REVIEWED_SEARCH_KEY]: { stdout: JSON.stringify([]) },
    "api user --jq .login": { stdout: "me" },
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

test("getCIStatus shells out to gh pr checks and returns the raw output", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  // `2>&1` is consumed by the shell, so the fake binary only sees the args.
  const responses: Record<string, FakeGhResponse> = {
    [`pr checks ${prUrl}`]: {
      stdout: "build\tpass\n",
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { getCIStatus } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const status = await getCIStatus(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(status));
    `
  );
  assert.equal(result, "build\tpass");
});

test("getCIStatus rejects URLs it can't parse", () => {
  const workspace = setupWorkspace();
  const { result } = runGhScript(
    workspace,
    `import { getCIStatus } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    {},
    `
      const status = await getCIStatus("not-a-url");
      console.log(JSON.stringify(status));
    `
  );
  assert.equal(result, "Could not parse PR URL.");
});

test("hasPendingChecks counts states that aren't terminal", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr checks ${prUrl} --json state --jq [.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length`]: {
      stdout: "2",
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { hasPendingChecks } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const pending = await hasPendingChecks(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(pending));
    `
  );
  assert.equal(result, true);
});

test("isPRMergedOrClosed maps the merged/closed signal", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`api repos/acme/widget/pulls/1 --jq .state + "|" + (.merged | tostring)`]:
      { stdout: "open|true" },
  };
  const { result } = runGhScript(
    workspace,
    `import { isPRMergedOrClosed } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await isPRMergedOrClosed(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "merged");
});

test("isPRMergedOrClosed returns closed when the PR is closed without merge", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`api repos/acme/widget/pulls/1 --jq .state + "|" + (.merged | tostring)`]:
      { stdout: "closed|false" },
  };
  const { result } = runGhScript(
    workspace,
    `import { isPRMergedOrClosed } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await isPRMergedOrClosed(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, "closed");
});

test("isPRMergedOrClosed returns null for open PRs", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`api repos/acme/widget/pulls/1 --jq .state + "|" + (.merged | tostring)`]:
      { stdout: "open|false" },
  };
  const { result } = runGhScript(
    workspace,
    `import { isPRMergedOrClosed } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const state = await isPRMergedOrClosed(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(state));
    `
  );
  assert.equal(result, null);
});

test("isPRMergedOrClosed throws when gh cannot inspect the PR", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`api repos/acme/widget/pulls/1 --jq .state + "|" + (.merged | tostring)`]:
      { stderr: "gh unavailable", exitCode: 1 },
  };
  const { result } = runGhScript(
    workspace,
    `import { isPRMergedOrClosed } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      try {
        await isPRMergedOrClosed(${JSON.stringify(prUrl)});
        console.log(JSON.stringify({ threw: false }));
      } catch (error) {
        console.log(JSON.stringify({
          threw: true,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    `
  );
  assert.deepEqual(result, { threw: true, message: "gh unavailable" });
});

test("getPRStatus reports clean / conflicts / unstable", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr checks ${prUrl} --json state --jq [.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length`]:
      { stdout: "0" },
    [`api repos/acme/widget/pulls/1 --jq {mergeable_state, mergeable}`]: {
      stdout: JSON.stringify({ mergeable_state: "clean", mergeable: true }),
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { getPRStatus } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const status = await getPRStatus(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(status));
    `
  );
  assert.equal(result, "clean");
});

test("getPRStatus reports needs_approval when blocked but mergeable", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`pr checks ${prUrl} --json state --jq [.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length`]:
      { stdout: "0" },
    [`api repos/acme/widget/pulls/1 --jq {mergeable_state, mergeable}`]: {
      stdout: JSON.stringify({ mergeable_state: "blocked", mergeable: true }),
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { getPRStatus } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const status = await getPRStatus(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(status));
    `
  );
  assert.equal(result, "needs_approval");
});

test("prNeedsAttention returns true when CHANGES_REQUESTED is on the PR", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    "api --paginate --slurp repos/acme/widget/pulls/1/reviews": {
      stdout: JSON.stringify([[{ state: "CHANGES_REQUESTED" }]]),
    },
    "api --paginate --slurp repos/acme/widget/pulls/1/comments": {
      stdout: JSON.stringify([[]]),
    },
    [`pr checks ${prUrl}`]: { stdout: "" },
  };
  const { result } = runGhScript(
    workspace,
    `import { prNeedsAttention } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const needs = await prNeedsAttention(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(needs));
    `
  );
  assert.equal(result, true);
});

test("prNeedsAttention returns false when nothing requires action", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    "api --paginate --slurp repos/acme/widget/pulls/1/reviews": {
      stdout: JSON.stringify([[]]),
    },
    "api --paginate --slurp repos/acme/widget/pulls/1/comments": {
      stdout: JSON.stringify([[]]),
    },
    [`pr checks ${prUrl}`]: { stdout: "ok" },
  };
  const { result } = runGhScript(
    workspace,
    `import { prNeedsAttention } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const needs = await prNeedsAttention(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(needs));
    `
  );
  assert.equal(result, false);
});

test("isPRBehindBase calls compare endpoint and reports behind > 0", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    [`api repos/acme/widget/pulls/1 --jq .head.ref + "..." + .base.ref`]: {
      stdout: "feature...main",
    },
    [`api repos/acme/widget/compare/feature...main --jq .behind_by`]: {
      stdout: "3",
    },
  };
  const { result } = runGhScript(
    workspace,
    `import { isPRBehindBase } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      const behind = await isPRBehindBase(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(behind));
    `
  );
  assert.equal(result, true);
});

test("updatePRBranch issues a PUT to the GitHub update-branch endpoint", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/1";
  const responses: Record<string, FakeGhResponse> = {
    "api repos/acme/widget/pulls/1/update-branch -X PUT": {
      stdout: "{}",
    },
  };
  const { result, calls } = runGhScript(
    workspace,
    `import { updatePRBranch } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    responses,
    `
      await updatePRBranch(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(null));
    `,
    { recordCalls: true }
  );
  assert.equal(result, null);
  // 2>&1 is interpreted by the shell; the binary only sees the args.
  assert.equal(
    calls.includes("api repos/acme/widget/pulls/1/update-branch -X PUT"),
    true
  );
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
