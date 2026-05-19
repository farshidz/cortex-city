// In-process unit tests for github.ts's pure helpers exposed via __testUtils.
// The shell-out helpers (exec, execJson, etc.) need a fake gh binary and stay
// covered by github.test.ts / github.reviews.test.ts subprocess tests.
import test from "node:test";
import assert from "node:assert/strict";

import { __testUtils } from "./github";

const {
  parsePRUrl,
  isNoChecksError,
  serializeCheckStates,
  isCommentFromSubmittedReview,
} = __testUtils;

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
