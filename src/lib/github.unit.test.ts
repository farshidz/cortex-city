// In-process unit tests for github.ts's pure helpers exposed via __testUtils.
// The shell-out helpers (exec, execJson, etc.) need a fake gh binary and stay
// covered by github.test.ts / github.reviews.test.ts subprocess tests.
import test from "node:test";
import assert from "node:assert/strict";

import * as github from "./github";

const {
  parsePRUrl,
  isNoChecksError,
  serializeCheckStates,
  isCommentFromSubmittedReview,
  isHashSignificantReview,
} = github.__testUtils;

test("github exports are reachable via module namespace", () => {
  assert.equal(typeof github.getAuthenticatedUserLogin, "function");
  assert.equal(typeof github.getCIStatus, "function");
  assert.equal(typeof github.getMyLastReviewSha, "function");
  assert.equal(typeof github.getLatestForeignCommentAt, "function");
  assert.equal(typeof github.getPRDiffHash, "function");
  assert.equal(typeof github.getPRHeadSha, "function");
  assert.equal(typeof github.getPRStateHash, "function");
  assert.equal(typeof github.listReviewerAuthoredComments, "function");
  assert.equal(typeof github.reviewDiffIdentityHash, "function");
  assert.equal(typeof github.getPRStatus, "function");
  assert.equal(typeof github.getReviewLifecycleState, "function");
  assert.equal(typeof github.getReviewRequestedPRs, "function");
  assert.equal(typeof github.getSubmittedCommentIds, "function");
  assert.equal(typeof github.hasPendingChecks, "function");
  assert.equal(typeof github.isPRBehindBase, "function");
  assert.equal(typeof github.isPRMergedOrClosed, "function");
  assert.equal(typeof github.prNeedsAttention, "function");
  assert.equal(typeof github.submitPRReview, "function");
  assert.equal(typeof github.updatePRBranch, "function");
  assert.equal(typeof github.__testUtils, "object");
});

test("reviewDiffIdentityHash survives a rebase but not a real edit", () => {
  const original = [
    "diff --git a/src/guard.ts b/src/guard.ts",
    "index 1111111..2222222 100644",
    "--- a/src/guard.ts",
    "+++ b/src/guard.ts",
    "@@ -10,6 +10,7 @@ export function guard() {",
    "   const limit = 4;",
    "-  if (value > limit) return false;",
    "+  if (value >= limit) return false;",
    "   return true;",
    "",
  ].join("\n");
  // Same change after a rebase: new blob hashes, shifted line numbers, and a
  // different hunk header. Only the line numbers are ignored, so the change
  // itself and its context still decide the identity.
  const rebased = [
    "diff --git a/src/guard.ts b/src/guard.ts",
    "index 3333333..4444444 100644",
    "--- a/src/guard.ts",
    "+++ b/src/guard.ts",
    "@@ -87,6 +92,7 @@ export function guard(input: Input) {",
    "   const limit = 4;",
    "-  if (value > limit) return false;",
    "+  if (value >= limit) return false;",
    "   return true;",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const edited = original.replace("value >= limit", "value >= limit + 1");
  // The same textual edit somewhere else in the file. Dropping context lines
  // made these collide, which silently skipped the review of the second one.
  const elsewhere = original
    .replace("const limit = 4;", "const ceiling = 9;")
    .replace("return true;", "return ok;");

  const hash = github.reviewDiffIdentityHash(original);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(github.reviewDiffIdentityHash(rebased), hash);
  assert.notEqual(github.reviewDiffIdentityHash(edited), hash);
  assert.notEqual(github.reviewDiffIdentityHash(elsewhere), hash);

  // A mode change and its reverse are different changes.
  const modeChange = [
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
  ].join("\n");
  const reverseModeChange = [
    "diff --git a/run.sh b/run.sh",
    "old mode 100755",
    "new mode 100644",
  ].join("\n");
  assert.notEqual(
    github.reviewDiffIdentityHash(modeChange),
    github.reviewDiffIdentityHash(reverseModeChange)
  );
  assert.notEqual(github.reviewDiffIdentityHash(modeChange), "");

  // Renames are part of the identity.
  assert.notEqual(
    github.reviewDiffIdentityHash(
      [
        "diff --git a/src/guard.ts b/src/shield.ts",
        "rename from src/guard.ts",
        "rename to src/shield.ts",
      ].join("\n")
    ),
    ""
  );

  // No identity where one cannot be computed, so callers fall back to head SHAs
  // and review again instead of treating two unknowns as the same change. A
  // binary diff is that case: `gh pr diff` says only that the files differ, so
  // no revision of a binary is distinguishable from any other.
  assert.equal(github.reviewDiffIdentityHash(""), "");
  assert.equal(
    github.reviewDiffIdentityHash(
      [
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
      ].join("\n")
    ),
    ""
  );
  assert.equal(
    github.reviewDiffIdentityHash(
      [
        "diff --git a/logo.png b/logo.png",
        "GIT binary patch",
        "delta 24",
      ].join("\n")
    ),
    ""
  );
  // A text change alongside a binary one is unidentifiable as a whole.
  assert.equal(
    github.reviewDiffIdentityHash(
      [original, "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ"].join("\n")
    ),
    ""
  );
});

test("parsePRUrl extracts owner/repo/number from canonical URLs", () => {
  assert.deepEqual(parsePRUrl("https://github.com/acme/widget/pull/123"), {
    owner: "acme",
    repo: "widget",
    number: "123",
  });
  assert.equal(parsePRUrl("not-a-pr-url"), null);
  assert.equal(parsePRUrl("https://example.com/pull/9"), null);
});

test("isNoChecksError recognises gh's no-checks phrasing", () => {
  assert.equal(isNoChecksError("no checks reported on branch x"), true);
  assert.equal(isNoChecksError("No checks reported"), true);
  assert.equal(isNoChecksError("rate limit"), false);
});

test("serializeCheckStates sorts, filters, and joins check rollup entries", () => {
  assert.equal(
    serializeCheckStates([
      { name: "build", state: "SUCCESS" },
      { name: "test", state: "FAILURE" },
      { name: "lint", state: "PENDING" },
      { name: "noop" },
      { state: "PASSED" },
    ]),
    "build=SUCCESS,lint=PENDING,test=FAILURE"
  );
  assert.equal(serializeCheckStates([]), "");
});

test("isCommentFromSubmittedReview matches only review-attached, non-pending ids", () => {
  const submitted = new Set([10, 11]);
  assert.equal(
    isCommentFromSubmittedReview(
      { id: 100, pull_request_review_id: 10 },
      submitted
    ),
    true
  );
  assert.equal(
    isCommentFromSubmittedReview(
      { id: 101, pull_request_review_id: 99 },
      submitted
    ),
    false
  );
  assert.equal(
    isCommentFromSubmittedReview(
      { id: 102, pull_request_review_id: null },
      submitted
    ),
    false
  );
});

test("isHashSignificantReview ignores only empty approvals", () => {
  assert.equal(isHashSignificantReview({ state: "APPROVED", body: "" }), false);
  assert.equal(isHashSignificantReview({ state: "APPROVED" }), false);
  assert.equal(isHashSignificantReview({ state: "APPROVED", body: "  " }), false);
  assert.equal(
    isHashSignificantReview({ state: "APPROVED", body: "Looks good after fix" }),
    true
  );
  assert.equal(isHashSignificantReview({ state: "COMMENTED", body: "" }), true);
  assert.equal(isHashSignificantReview({ state: "CHANGES_REQUESTED", body: "" }), true);
  assert.equal(isHashSignificantReview({ state: "PENDING", body: "draft" }), false);
});
