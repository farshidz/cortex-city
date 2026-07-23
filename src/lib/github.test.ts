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
        `import { deliverReviewerComment, getPRHeadSha, getPRStateHash, getSubmittedCommentIds } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
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
    [checksKey(prUrl)]: { stdout: "" },
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
    .update(
      'abc123|[100]|[]|[{"id":11,"state":"APPROVED"},{"id":12,"state":"COMMENTED"}]|'
    )
    .digest("hex")
    .slice(0, 16);
  assert.equal(hash, expected);
});
