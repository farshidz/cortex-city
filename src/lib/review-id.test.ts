import test from "node:test";
import assert from "node:assert/strict";

import { decodeReviewId, encodeReviewId } from "./review-id";

test("encodeReviewId is URL-safe and reversible", () => {
  const url = "https://github.com/marqo-ai/cloud_control_plane/pull/2919";
  const id = encodeReviewId(url);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeReviewId(id), url);
});

test("encodeReviewId tolerates URL-safe characters in repo and branch names", () => {
  const url =
    "https://github.com/example/repo.with-dots_and_underscores/pull/1";
  assert.equal(decodeReviewId(encodeReviewId(url)), url);
});

test("encodeReviewId roundtrips multibyte characters", () => {
  const url = "https://github.com/example/repo/pull/42?title=résumé-✓";
  assert.equal(decodeReviewId(encodeReviewId(url)), url);
});
