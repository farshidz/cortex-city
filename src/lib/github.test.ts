import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createTempWorkspace as createHarnessWorkspace,
  prependBinToPath,
  readJson,
  writeFakeGhBinary,
  writeJson,
} from "./test-harness";

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
const { appendFileSync, readFileSync } = require("fs");

const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES_FILE, "utf8"));
const key = process.argv.slice(2).join(" ");
appendFileSync(process.env.FAKE_GH_CALLS_FILE, JSON.stringify(key) + "\\n");
const response = responses[key] || (
  key.startsWith("api graphql -f query=query CortexCityPullRequestSnapshots")
    ? responses.__graphql_snapshots__
    : undefined
);

if (!response) {
  process.stderr.write("No fake gh response for: " + key);
  process.exit(1);
}

if (response.stderr) {
  process.stderr.write(response.stderr);
}

process.stdout.write(response.stdout || "");

if (response.exitCode) {
  process.exit(response.exitCode);
}
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
  const callsFile = path.join(workspace, "gh-calls.txt");
  writeFileSync(responsesFile, JSON.stringify(responses, null, 2));
  writeFileSync(callsFile, "");

  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { deliverReviewerComment, getCommitMergeBaseSha, getMyReviewSignals, getPRHeadSha, getPRSnapshots, getPRStateHash, getSubmittedCommentIds, getLatestForeignCommentAt, getReviewConversation, listReviewerAuthoredComments } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
        `import { readFileSync } from "node:fs";`,
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
        FAKE_GH_CALLS_FILE: callsFile,
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

function seedTrackedDecisionCommentIds(
  workspace: string,
  prUrl: string,
  ids: number[]
): void {
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify({
      [prUrl]: {
        pr_url: prUrl,
        source: "inbound",
        reviewer_comment_receipts: ids.map((id) => ({
          action_token: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
          comment_id: id,
          author_login: "me",
          body_sha256: "a".repeat(64),
        })),
      },
    })
  );
}

function prViewKey(prUrl: string): string {
  return `pr view ${prUrl} --json headRefOid,statusCheckRollup`;
}

function prHeadShaKey(prUrl: string): string {
  return `pr view ${prUrl} --json headRefOid`;
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

function prDeliveryTargetKey(): string {
  return "api repos/acme/widget/pulls/123";
}

function checksKey(prUrl: string): string {
  return `pr checks ${prUrl} --json name,state`;
}

function completeSnapshotNode(headSha: string) {
  return {
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    headRefOid: headSha,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    updatedAt: "2026-05-01T00:00:00Z",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "test",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: [] },
    comments: {
      nodes: [{ databaseId: 7, updatedAt: "2026-05-01T00:00:00Z" }],
    },
  };
}

test("getPRSnapshots batches PR state, refs, and checks into one GraphQL call", () => {
  const workspace = setupWorkspace();
  const firstUrl = "https://github.com/acme/widget/pull/123";
  const secondUrl = "https://github.com/acme/widget/pull/124";
  const graphQLResponse = {
    data: {
      r0: {
        p0: {
          state: "OPEN",
          mergedAt: null,
          mergeCommit: null,
          headRefOid: "head-123",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          updatedAt: "2026-05-01T00:00:00Z",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "test",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            ],
          },
          reviews: { nodes: [] },
          comments: { nodes: [] },
        },
        p1: {
          state: "CLOSED",
          mergedAt: "2026-05-02T00:00:00Z",
          mergeCommit: { oid: "merge-124" },
          headRefOid: "head-124",
          baseRefName: "release",
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          updatedAt: "2026-05-02T00:00:00Z",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "deploy",
                          status: "IN_PROGRESS",
                          conclusion: null,
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            ],
          },
          reviews: {
            nodes: [
              {
                databaseId: 9,
                state: "APPROVED",
                submittedAt: "2026-05-01T23:00:00Z",
                commit: { oid: "head-124" },
              },
            ],
          },
          comments: { nodes: [] },
        },
      },
    },
  };

  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: { stdout: JSON.stringify(graphQLResponse) },
    },
    `
      const snapshots = await getPRSnapshots(${JSON.stringify([
        firstUrl,
        secondUrl,
        firstUrl,
      ])});
      const calls = readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf8")
        .trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      console.log(JSON.stringify({ snapshots, calls }));
    `
  ) as {
    snapshots: Record<string, {
      state: string;
      head_sha: string;
      base_branch: string;
      merge_commit_sha?: string;
      pr_status: string;
      checks_state: string;
      observation_key: string;
    }>;
    calls: string[];
  };

  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /^api graphql -f query=query CortexCity/);
  assert.deepEqual(Object.keys(result.snapshots).sort(), [firstUrl, secondUrl]);
  assert.deepEqual(
    {
      state: result.snapshots[firstUrl].state,
      head: result.snapshots[firstUrl].head_sha,
      base: result.snapshots[firstUrl].base_branch,
      status: result.snapshots[firstUrl].pr_status,
      checks: result.snapshots[firstUrl].checks_state,
    },
    {
      state: "open",
      head: "head-123",
      base: "main",
      status: "needs_approval",
      checks: "test=SUCCESS",
    }
  );
  assert.equal(result.snapshots[secondUrl].state, "merged");
  assert.equal(result.snapshots[secondUrl].merge_commit_sha, "merge-124");
  assert.equal(result.snapshots[secondUrl].pr_status, "checks_pending");
  assert.match(result.snapshots[firstUrl].observation_key, /^[0-9a-f]{16}$/);
  assert.notEqual(
    result.snapshots[firstUrl].observation_key,
    result.snapshots[secondUrl].observation_key
  );
});

test("getPRStateHash uses the same check ordering for polling and completion", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const checkNames = [
    "Build and Test",
    "Build Go Images",
    "comment-preview-link",
    "Detect Changes",
    "Lint",
    "Lint Python",
  ];
  const snapshotNode = completeSnapshotNode("abc123");
  snapshotNode.commits.nodes[0].commit.statusCheckRollup.contexts.nodes =
    checkNames.map((name) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }));
  const directChecks = [...checkNames].reverse().map((name) => ({
    name,
    state: "SUCCESS",
  }));

  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: {
        stdout: JSON.stringify({ data: { r0: { p0: snapshotNode } } }),
      },
      [prViewKey(prUrl)]: {
        stdout: JSON.stringify({
          headRefOid: "abc123",
          statusCheckRollup: directChecks,
        }),
      },
      [checksKey(prUrl)]: { stdout: JSON.stringify(directChecks) },
      [reviewsKey()]: { stdout: JSON.stringify([[]]) },
      [reviewCommentsKey()]: { stdout: JSON.stringify([[]]) },
      [issueCommentsKey()]: { stdout: JSON.stringify([[]]) },
    },
    `
      const snapshots = await getPRSnapshots([${JSON.stringify(prUrl)}]);
      const snapshot = snapshots[${JSON.stringify(prUrl)}];
      const pollingHash = await getPRStateHash(${JSON.stringify(prUrl)}, snapshot);
      const completionHash = await getPRStateHash(${JSON.stringify(prUrl)});
      console.log(JSON.stringify({
        checksState: snapshot?.checks_state,
        pollingHash,
        completionHash,
      }));
    `
  ) as {
    checksState: string;
    pollingHash: string;
    completionHash: string;
  };

  assert.equal(
    result.checksState,
    "Build Go Images=SUCCESS,Build and Test=SUCCESS,Detect Changes=SUCCESS," +
      "Lint Python=SUCCESS,Lint=SUCCESS,comment-preview-link=SUCCESS"
  );
  assert.equal(result.pollingHash, result.completionHash);
});

test("getPRSnapshots omits a PR whose check connection has another page", () => {
  const workspace = setupWorkspace();
  const firstUrl = "https://github.com/acme/widget/pull/123";
  const secondUrl = "https://github.com/acme/widget/pull/124";
  const partial = completeSnapshotNode("head-123");
  partial.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage =
    true;

  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: {
        stdout: JSON.stringify({
          data: {
            r0: {
              p0: partial,
              p1: completeSnapshotNode("head-124"),
            },
          },
        }),
      },
    },
    `
      const snapshots = await getPRSnapshots(${JSON.stringify([
        firstUrl,
        secondUrl,
      ])});
      console.log(JSON.stringify(Object.keys(snapshots).sort()));
    `
  ) as string[];

  assert.deepEqual(result, [secondUrl]);
});

test("getPRSnapshots omits only the PR affected by a field-level GraphQL error", () => {
  const workspace = setupWorkspace();
  const firstUrl = "https://github.com/acme/widget/pull/123";
  const secondUrl = "https://github.com/acme/widget/pull/124";
  const partial = {
    ...completeSnapshotNode("head-123"),
    mergeStateStatus: undefined,
  };
  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: {
        stdout: JSON.stringify({
          data: {
            r0: {
              p0: partial,
              p1: completeSnapshotNode("head-124"),
            },
          },
          errors: [
            {
              message: "Could not resolve merge state",
              path: ["r0", "p0", "mergeStateStatus"],
            },
          ],
        }),
        stderr: "GraphQL: Could not resolve merge state",
        exitCode: 1,
      },
    },
    `
      const snapshots = await getPRSnapshots(${JSON.stringify([
        firstUrl,
        secondUrl,
      ])});
      console.log(JSON.stringify(Object.keys(snapshots).sort()));
    `
  ) as string[];

  assert.deepEqual(result, [secondUrl]);
});

test("getPRSnapshots omits structurally incomplete scheduling data without an error path", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: {
        stdout: JSON.stringify({
          data: {
            r0: {
              p0: { ...completeSnapshotNode("head-123"), baseRefName: undefined },
            },
          },
        }),
      },
    },
    `
      const snapshots = await getPRSnapshots([${JSON.stringify(prUrl)}]);
      console.log(JSON.stringify(snapshots));
    `
  ) as Record<string, unknown>;

  assert.deepEqual(result, {});
});

test("getPRSnapshots omits the batch when GraphQL returns an unscoped error", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const result = runGithubScript(
    workspace,
    {
      __graphql_snapshots__: {
        stdout: JSON.stringify({
          data: { r0: { p0: completeSnapshotNode("head-123") } },
          errors: [{ message: "Snapshot query was only partially evaluated" }],
        }),
      },
    },
    `
      const snapshots = await getPRSnapshots([${JSON.stringify(prUrl)}]);
      console.log(JSON.stringify(snapshots));
    `
  ) as Record<string, unknown>;

  assert.deepEqual(result, {});
});

test("snapshot observation keys cache detailed PR activity across consumers", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [reviewsKey()]: { stdout: JSON.stringify([[]]) },
    [reviewCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [issueCommentsKey()]: { stdout: JSON.stringify([[]]) },
  };

  const result = runGithubScript(
    workspace,
    responses,
    `
      const snapshot = {
        pr_url: ${JSON.stringify(prUrl)},
        state: "open",
        head_sha: "abc123",
        base_branch: "main",
        pr_status: "clean",
        checks_state: "test=SUCCESS",
        updated_at: "2026-05-01T00:00:00Z",
        observation_key: "snapshot-a",
      };
      await getPRStateHash(${JSON.stringify(prUrl)}, snapshot);
      await getPRStateHash(${JSON.stringify(prUrl)}, snapshot);
      await getLatestForeignCommentAt(${JSON.stringify(prUrl)}, snapshot.observation_key);
      await getMyReviewSignals(${JSON.stringify(prUrl)}, "me", snapshot.observation_key);
      const firstCalls = readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf8")
        .trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      await getPRStateHash(${JSON.stringify(prUrl)}, {
        ...snapshot,
        observation_key: "snapshot-b",
      });
      const allCalls = readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf8")
        .trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      console.log(JSON.stringify({
        firstDetailedCalls: firstCalls.filter((call) => call.includes("--paginate --slurp")).length,
        allDetailedCalls: allCalls.filter((call) => call.includes("--paginate --slurp")).length,
      }));
    `
  ) as { firstDetailedCalls: number; allDetailedCalls: number };

  assert.deepEqual(result, { firstDetailedCalls: 3, allDetailedCalls: 6 });
});

test("GitHub calls back off after a rate-limit response", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const result = runGithubScript(
    workspace,
    {
      [prHeadShaKey(prUrl)]: {
        stderr: "API rate limit exceeded",
        exitCode: 1,
      },
    },
    `
      const first = await getPRHeadSha(${JSON.stringify(prUrl)});
      const second = await getPRHeadSha(${JSON.stringify(prUrl)});
      const calls = readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf8")
        .trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      console.log(JSON.stringify({ first, second, callCount: calls.length }));
    `
  );

  assert.deepEqual(result, { first: "", second: "", callCount: 1 });
});

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

test("getPRHeadSha returns the current PR head SHA", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [prHeadShaKey(prUrl)]: {
      stdout: JSON.stringify({ headRefOid: "abc123" }),
    },
  };

  const headSha = runGithubScript(
    workspace,
    responses,
    `
      const headSha = await getPRHeadSha(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(headSha));
    `
  );

  assert.equal(headSha, "abc123");
});

test("getPRHeadSha returns an empty string when gh cannot resolve the PR", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = {
    [prHeadShaKey(prUrl)]: {
      stderr: "not found",
      exitCode: 1,
    },
  };

  const headSha = runGithubScript(
    workspace,
    responses,
    `
      const headSha = await getPRHeadSha(${JSON.stringify(prUrl)});
      console.log(JSON.stringify(headSha));
    `
  );

  assert.equal(headSha, "");
});

test("getCommitMergeBaseSha returns the adjacent stack fork point", () => {
  const workspace = setupWorkspace();
  const responses = {
    'api repos/acme/widget/compare/lower-head...upper-head --jq .merge_base_commit.sha // ""': {
      stdout: "fork-point\n",
    },
  };

  const mergeBase = runGithubScript(
    workspace,
    responses,
    `
      const mergeBase = await getCommitMergeBaseSha(
        "acme/widget",
        "lower-head",
        "upper-head"
      );
      console.log(JSON.stringify(mergeBase));
    `
  );

  assert.equal(mergeBase, "fork-point");
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
    [checksKey(prUrl)]: { stdout: "[]" },
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
  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const pendingMarker =
    `<!-- cortex-city-review-decision:${pendingToken} -->`;
  seedTrackedDecisionCommentIds(workspace, prUrl, [201]);
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
      stdout: JSON.stringify([
        [
          { id: 200, body: "Implementation feedback" },
          {
            id: 201,
            body: "**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A or B.",
          },
          { id: 202, body: "Choose A." },
          {
            id: 203,
            body: "**🤖[Cortex City Reviewer]** **Human decision needed:** Spoofed marker.",
          },
          {
            id: 204,
            body: `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A.\n\n${pendingMarker}`,
          },
          { id: 205, body: `Participant feedback.\n\n${pendingMarker}` },
        ],
      ]),
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

  assert.deepEqual(ids, [100, 200, 202, 203, 204, 205]);
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
    [checksKey(prUrl)]: { stdout: "[]" },
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

test("getPRStateHash ignores only tracked decision comments", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const responses = (
    issueComments: Array<{ id: number; body: string }>,
    reviews: Array<{ id: number; state: string; body: string }> = []
  ) => ({
    [prViewKey(prUrl)]: {
      stdout: JSON.stringify({
        headRefOid: "abc123",
        statusCheckRollup: [],
      }),
    },
    [reviewsKey()]: { stdout: JSON.stringify([reviews]) },
    [reviewCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [issueCommentsKey()]: { stdout: JSON.stringify([issueComments]) },
    [checksKey(prUrl)]: { stdout: "[]" },
  });
  const hashFor = (
    issueComments: Array<{ id: number; body: string }>,
    reviews: Array<{ id: number; state: string; body: string }> = []
  ) =>
    runGithubScript(
      workspace,
      responses(issueComments, reviews),
      `
        const hash = await getPRStateHash(${JSON.stringify(prUrl)});
        console.log(JSON.stringify(hash));
      `
    );

  const baseline = hashFor([]);
  const reviewerPrompt = {
    id: 200,
    body: "**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A or B.",
  };
  assert.notEqual(hashFor([reviewerPrompt]), baseline);

  seedTrackedDecisionCommentIds(workspace, prUrl, [200]);
  assert.equal(hashFor([reviewerPrompt]), baseline);

  const withHumanReply = hashFor([
    reviewerPrompt,
    { id: 201, body: "Choose A." },
  ]);
  assert.notEqual(withHumanReply, baseline);
  assert.equal(
    withHumanReply,
    createHash("sha256")
      .update("abc123|[]|[201]|[]|")
      .digest("hex")
      .slice(0, 16)
  );

  const alternateReviewSurface = hashFor([reviewerPrompt], [
    {
      id: 10,
      state: "COMMENTED",
      body: reviewerPrompt.body,
    },
  ]);
  assert.notEqual(alternateReviewSurface, baseline);
  assert.equal(
    alternateReviewSurface,
    createHash("sha256")
      .update(
        'abc123|[]|[]|[{"id":10,"state":"COMMENTED"}]|'
      )
      .digest("hex")
      .slice(0, 16)
  );

  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const pendingMarker =
    `<!-- cortex-city-review-decision:${pendingToken} -->`;
  const pendingComment = {
    id: 300,
    body: `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A.\n\n${pendingMarker}`,
  };
  seedTrackedDecisionCommentIds(workspace, prUrl, []);
  assert.notEqual(hashFor([pendingComment]), baseline);

  const pendingSelfApprovalComment = {
    id: 302,
    body: `**🤖[Cortex City Reviewer]** **Ready for manual approval:** Please approve manually.\n\n${pendingMarker}`,
  };
  assert.notEqual(hashFor([pendingSelfApprovalComment]), baseline);

  const copiedPendingMarker = hashFor([
    pendingComment,
    { id: 301, body: `Participant feedback.\n\n${pendingMarker}` },
  ]);
  assert.equal(
    copiedPendingMarker,
    createHash("sha256")
      .update("abc123|[]|[300,301]|[]|")
      .digest("hex")
      .slice(0, 16)
  );
});

test("getPRStateHash ignores every reviewer-authored comment surface", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const reviewerBody = "**🤖[Cortex City Reviewer]** This assertion is inverted.";
  const hashFor = (
    issueComments: Array<Record<string, unknown>>,
    reviewComments: Array<Record<string, unknown>>,
    reviews: Array<Record<string, unknown>>
  ) =>
    runGithubScript(
      workspace,
      {
        "api user --jq .login": { stdout: "me" },
        [prViewKey(prUrl)]: {
          stdout: JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [] }),
        },
        [reviewsKey()]: { stdout: JSON.stringify([reviews]) },
        [reviewCommentsKey()]: { stdout: JSON.stringify([reviewComments]) },
        [issueCommentsKey()]: { stdout: JSON.stringify([issueComments]) },
        [checksKey(prUrl)]: { stdout: "[]" },
      },
      `
        const hash = await getPRStateHash(${JSON.stringify(prUrl)});
        console.log(JSON.stringify(hash));
      `
    );

  const baseline = hashFor([], [], []);

  // An inline finding comment plus the empty COMMENTED review GitHub wraps it
  // in: neither may move the hash.
  assert.equal(
    hashFor(
      [],
      [
        {
          id: 700,
          pull_request_review_id: 40,
          body: reviewerBody,
          user: { login: "me" },
        },
      ],
      [{ id: 40, state: "COMMENTED", body: "", user: { login: "me" } }]
    ),
    baseline
  );

  // A reviewer conversation comment on the issue surface.
  assert.equal(
    hashFor(
      [{ id: 800, body: reviewerBody, user: { login: "me" } }],
      [],
      []
    ),
    baseline
  );

  // The same comment IDs from someone else copying the marker still count, and
  // so does a wrapping review that owns a non-reviewer comment.
  assert.notEqual(
    hashFor(
      [{ id: 800, body: reviewerBody, user: { login: "participant" } }],
      [],
      []
    ),
    baseline
  );
  assert.notEqual(
    hashFor(
      [],
      [
        {
          id: 700,
          pull_request_review_id: 40,
          body: reviewerBody,
          user: { login: "me" },
        },
        {
          id: 701,
          pull_request_review_id: 40,
          body: "I disagree.",
          user: { login: "participant" },
        },
      ],
      [{ id: 40, state: "COMMENTED", body: "", user: { login: "me" } }]
    ),
    baseline
  );

  // A decisive review by the signed-in user is never filtered, whatever its
  // body says.
  assert.notEqual(
    hashFor(
      [],
      [],
      [
        {
          id: 41,
          state: "CHANGES_REQUESTED",
          body: reviewerBody,
          user: { login: "me" },
        },
      ]
    ),
    baseline
  );
});

test("a copied reviewer prefix only suppresses when the author shares the reviewer login", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const marker = "**🤖[Cortex City Reviewer]**";
  const hashFor = (
    issueComments: Array<Record<string, unknown>>,
    reviewComments: Array<Record<string, unknown>> = [],
    reviews: Array<Record<string, unknown>> = []
  ) =>
    runGithubScript(
      workspace,
      {
        "api user --jq .login": { stdout: "me" },
        [prViewKey(prUrl)]: {
          stdout: JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [] }),
        },
        [reviewsKey()]: { stdout: JSON.stringify([reviews]) },
        [reviewCommentsKey()]: { stdout: JSON.stringify([reviewComments]) },
        [issueCommentsKey()]: { stdout: JSON.stringify([issueComments]) },
        [checksKey(prUrl)]: { stdout: "[]" },
      },
      `
        const hash = await getPRStateHash(${JSON.stringify(prUrl)});
        console.log(JSON.stringify(hash));
      `
    );

  const baseline = hashFor([]);

  // Another participant copying the marker is never suppressed, on either
  // surface or through a wrapping review.
  for (const copied of [
    hashFor([{ id: 800, body: `${marker} Copied.`, user: { login: "octocat" } }]),
    hashFor(
      [],
      [
        {
          id: 700,
          pull_request_review_id: 40,
          body: `${marker} Copied.`,
          user: { login: "octocat" },
        },
      ],
      [{ id: 40, state: "COMMENTED", body: "", user: { login: "octocat" } }]
    ),
  ]) {
    assert.notEqual(copied, baseline);
  }

  // Leading whitespace means a human typed or quoted it, so the anchored match
  // leaves it as conversation even under the reviewer's own login.
  assert.notEqual(
    hashFor([{ id: 801, body: `  ${marker} Quoted.`, user: { login: "me" } }]),
    baseline
  );
  assert.notEqual(
    hashFor([{ id: 802, body: `> ${marker} Quoted.`, user: { login: "me" } }]),
    baseline
  );

  // The accepted residual risk, asserted so it is visible rather than implicit:
  // on a self-authored PR the human author shares the reviewer's login, so a
  // human comment that literally starts with the marker is suppressed.
  assert.equal(
    hashFor([{ id: 803, body: `${marker} Typed by the author.`, user: { login: "me" } }]),
    baseline
  );
});

test("the conversation clock tracks published foreign feedback only", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const marker = "**🤖[Cortex City Reviewer]**";
  const latestFor = (
    reviews: Array<Record<string, unknown>>,
    reviewComments: Array<Record<string, unknown>> = [],
    issueComments: Array<Record<string, unknown>> = []
  ) =>
    runGithubScript(
      workspace,
      {
        "api user --jq .login": { stdout: "me" },
        [reviewsKey()]: { stdout: JSON.stringify([reviews]) },
        [reviewCommentsKey()]: { stdout: JSON.stringify([reviewComments]) },
        [issueCommentsKey()]: { stdout: JSON.stringify([issueComments]) },
      },
      `
        const latest = await getLatestForeignCommentAt(${JSON.stringify(prUrl)});
        console.log(JSON.stringify(latest));
      `
    );

  // A submitted review whose feedback is only in its body is conversation.
  assert.equal(
    latestFor([
      {
        id: 40,
        state: "CHANGES_REQUESTED",
        body: "Please split this.",
        user: { login: "octocat" },
        submitted_at: "2026-05-01T00:30:00.000Z",
      },
    ]),
    "2026-05-01T00:30:00.000Z"
  );

  // A pending draft is not published, so neither its own body nor its inline
  // comments may start a reply round.
  assert.equal(
    latestFor(
      [
        {
          id: 41,
          state: "PENDING",
          body: "Draft thoughts.",
          user: { login: "octocat" },
          submitted_at: "2026-05-01T00:30:00.000Z",
        },
      ],
      [
        {
          id: 700,
          pull_request_review_id: 41,
          body: "Draft inline note.",
          user: { login: "octocat" },
          created_at: "2026-05-01T00:30:00.000Z",
        },
      ]
    ),
    ""
  );

  // The same inline comment counts once its review is submitted.
  assert.equal(
    latestFor(
      [
        {
          id: 41,
          state: "COMMENTED",
          body: "",
          user: { login: "octocat" },
          submitted_at: "2026-05-01T00:29:00.000Z",
        },
      ],
      [
        {
          id: 700,
          pull_request_review_id: 41,
          body: "Inline note.",
          user: { login: "octocat" },
          created_at: "2026-05-01T00:30:00.000Z",
        },
      ]
    ),
    "2026-05-01T00:30:00.000Z"
  );

  // The reviewer talking to itself is not conversation, on any surface.
  assert.equal(
    latestFor(
      [
        {
          id: 42,
          state: "COMMENTED",
          body: `${marker} My own review body.`,
          user: { login: "me" },
          submitted_at: "2026-05-01T00:30:00.000Z",
        },
      ],
      [],
      [
        {
          id: 800,
          body: `${marker} My own summary.`,
          user: { login: "me" },
          created_at: "2026-05-01T00:31:00.000Z",
        },
      ]
    ),
    ""
  );

  // The newest published item wins.
  assert.equal(
    latestFor(
      [
        {
          id: 43,
          state: "COMMENTED",
          body: "Earlier review body.",
          user: { login: "octocat" },
          submitted_at: "2026-05-01T00:10:00.000Z",
        },
      ],
      [],
      [
        {
          id: 801,
          body: "Later comment.",
          user: { login: "octocat" },
          created_at: "2026-05-01T00:40:00.000Z",
        },
      ]
    ),
    "2026-05-01T00:40:00.000Z"
  );
});

test("listReviewerAuthoredComments reports the run's own comments per surface", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const reviewerBody = "**🤖[Cortex City Reviewer]** Reply on the open thread.";
  const result = runGithubScript(
    workspace,
    {
      "api user --jq .login": { stdout: "me" },
      [reviewCommentsKey()]: {
        stdout: JSON.stringify([
          [
            {
              id: 700,
              pull_request_review_id: 40,
              body: reviewerBody,
              user: { login: "me" },
              created_at: "2026-05-01T00:30:00.000Z",
            },
            {
              id: 701,
              pull_request_review_id: 41,
              body: reviewerBody,
              user: { login: "me" },
              created_at: "2026-05-01T00:00:00.000Z",
            },
          ],
        ]),
      },
      [issueCommentsKey()]: {
        stdout: JSON.stringify([
          [
            {
              id: 800,
              body: reviewerBody,
              user: { login: "me" },
              created_at: "2026-05-01T00:30:00.000Z",
            },
            {
              id: 801,
              body: "Plain human comment.",
              user: { login: "me" },
              created_at: "2026-05-01T00:30:00.000Z",
            },
            {
              id: 802,
              body: reviewerBody,
              user: { login: "participant" },
              created_at: "2026-05-01T00:30:00.000Z",
            },
          ],
        ]),
      },
    },
    `
      const receipts = await listReviewerAuthoredComments(
        ${JSON.stringify(prUrl)},
        "2026-05-01T00:15:00.000Z"
      );
      console.log(JSON.stringify(receipts));
    `
  );

  assert.deepEqual(
    result.map(
      (receipt: { comment_id: number; surface: string }) =>
        `${receipt.surface}:${receipt.comment_id}`
    ),
    ["review_comment:700", "issue:800"]
  );
  assert.equal(result[0].author_login, "me");
  assert.equal(result[0].action_token, undefined);
  assert.equal(
    result[0].body_sha256,
    createHash("sha256").update(reviewerBody).digest("hex")
  );
});

test("deliverReviewerComment recovers only an exact authenticated event and verifies new receipts", () => {
  const prUrl = "https://github.com/acme/widget/pull/123";
  const token = "11111111-1111-4111-8111-111111111111";
  const body =
    `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A.\n\n` +
    `<!-- cortex-city-review-decision:${token} -->`;
  const delivery = {
    action_token: token,
    kind: "human_decision",
    head_sha: "abc123",
    body,
  };

  const recovered = runGithubScript(
    setupWorkspace(),
    {
      "api user --jq .login": { stdout: "me" },
      [issueCommentsKey()]: {
        stdout: JSON.stringify([
          [{ id: 300, body, user: { login: "me" } }],
        ]),
      },
    },
    `
      const receipt = await deliverReviewerComment(
        ${JSON.stringify(prUrl)},
        ${JSON.stringify(delivery)}
      );
      console.log(JSON.stringify(receipt));
    `
  );
  assert.equal(recovered.comment_id, 300);
  assert.equal(recovered.author_login, "me");
  assert.equal(
    recovered.body_sha256,
    createHash("sha256").update(body).digest("hex")
  );

  const posted = runGithubScript(
    setupWorkspace(),
    {
      "api user --jq .login": { stdout: "me" },
      [issueCommentsKey()]: {
        stdout: JSON.stringify([
          [{ id: 300, body, user: { login: "participant" } }],
        ]),
      },
      [prDeliveryTargetKey()]: {
        stdout: JSON.stringify({
          state: "open",
          merged: false,
          head: { sha: "abc123" },
        }),
      },
      [`api --method POST repos/acme/widget/issues/123/comments --raw-field body=${body} --jq .id`]: {
        stdout: "301",
      },
      "api repos/acme/widget/issues/comments/301": {
        stdout: JSON.stringify({ id: 301, body, user: { login: "me" } }),
      },
    },
    `
      const receipt = await deliverReviewerComment(
        ${JSON.stringify(prUrl)},
        ${JSON.stringify(delivery)}
      );
      console.log(JSON.stringify(receipt));
    `
  );
  assert.equal(posted.comment_id, 301);
  assert.equal(posted.author_login, "me");
});

test("deliverReviewerComment serializes concurrent recovery and POST attempts", () => {
  const workspace = createHarnessWorkspace("github-delivery-lock-");
  writeFakeGhBinary(workspace);
  const stateFile = path.join(workspace, "gh-state.json");
  const callsFile = path.join(workspace, "gh-calls.jsonl");
  const prUrl = "https://github.com/acme/widget/pull/123";
  const token = "11111111-1111-4111-8111-111111111111";
  const body =
    `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A.\n\n` +
    `<!-- cortex-city-review-decision:${token} -->`;
  const delivery = {
    action_token: token,
    kind: "human_decision",
    head_sha: "abc123",
    body,
  };
  writeJson(stateFile, {
    viewerLogin: "me",
    prs: {
      "acme/widget#123": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        issueComments: [],
        nextIssueCommentId: 700,
      },
    },
  });

  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { deliverReviewerComment } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
        "(async () => {",
        `  const delivery = ${JSON.stringify(delivery)};`,
        `  const receipts = await Promise.all([`,
        `    deliverReviewerComment(${JSON.stringify(prUrl)}, delivery),`,
        `    deliverReviewerComment(${JSON.stringify(prUrl)}, delivery),`,
        "  ]);",
        "  console.log(JSON.stringify(receipts));",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
      env: {
        ...prependBinToPath(workspace),
        FAKE_GH_STATE_FILE: stateFile,
        FAKE_GH_CALLS_FILE: callsFile,
        FAKE_GH_ISSUE_COMMENT_LIST_DELAY_MS: "150",
      },
    }
  );
  const receipts = JSON.parse(output.trim().split(/\r?\n/).pop()!);
  const state = readJson<{
    prs: Record<string, { issueComments: Array<{ id: number }> }>;
  }>(stateFile);
  const calls = readFileSync(callsFile, "utf-8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as string[]);
  const posts = calls.filter(
    (args) => args[0] === "api" && args[1] === "--method" && args[2] === "POST"
  );

  assert.deepEqual(
    receipts.map((receipt: { comment_id: number }) => receipt.comment_id),
    [700, 700]
  );
  assert.equal(state.prs["acme/widget#123"].issueComments.length, 1);
  assert.equal(posts.length, 1);
});

test("getPRStateHash ignores empty approvals but keeps their inline comments", () => {
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
          { id: 10, state: "APPROVED", body: "" },
          { id: 11, state: "APPROVED", body: "LGTM after the fix" },
          { id: 12, state: "COMMENTED", body: "" },
          { id: 13, state: "PENDING", body: "draft" },
        ],
      ]),
    },
    [reviewCommentsKey()]: {
      stdout: JSON.stringify([
        [
          { id: 100, pull_request_review_id: 10 },
          { id: 101, pull_request_review_id: 13 },
          { id: 102, pull_request_review_id: null },
        ],
      ]),
    },
    [issueCommentsKey()]: { stdout: JSON.stringify([[]]) },
    [checksKey(prUrl)]: { stdout: "[]" },
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
    .update(
      'abc123|[100]|[]|[{"id":11,"state":"APPROVED"},{"id":12,"state":"COMMENTED"}]|'
    )
    .digest("hex")
    .slice(0, 16);
  assert.equal(hash, expected);
});


test("conversation snapshots retain edited versions across surfaces and exclude reviewer output and drafts", () => {
  const workspace = setupWorkspace();
  const prUrl = "https://github.com/acme/widget/pull/123";
  const foreign = { login: "octocat" };
  const result = runGithubScript(workspace, {
    "api user --jq .login": { stdout: "me" },
    [reviewsKey()]: { stdout: JSON.stringify([[{id: 1, state: "CHANGES_REQUESTED", body: "Split this", user: foreign}, {id: 2, state: "PENDING", body: "Draft", user: foreign}]]) },
    [reviewCommentsKey()]: { stdout: JSON.stringify([[{id: 1, pull_request_review_id: 1, body: "Inline", user: foreign}, {id: 2, pull_request_review_id: 2, body: "Draft inline", user: foreign}]]) },
    [issueCommentsKey()]: { stdout: JSON.stringify([[{id: 1, body: "Edited", user: foreign, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-02T00:00:00Z"}, {id: 2, body: "**🤖[Cortex City Reviewer]** Reply", user: {login: "me"}}]]) },
  }, `console.log(JSON.stringify(await getReviewConversation(${JSON.stringify(prUrl)})));`);
  assert.deepEqual(result.map((item: {surface: string}) => item.surface), ["review_comment", "issue", "review"]);
  assert.equal(new Set(result.map((item: {key: string}) => item.key)).size, 3);
  assert.equal(result[1].updated_at, "2026-05-02T00:00:00Z");
  assert.match(result[2].key, /^review:1:CHANGES_REQUESTED:/);
});
