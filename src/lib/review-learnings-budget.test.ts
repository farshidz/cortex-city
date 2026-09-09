import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REVIEW_LEARNINGS_BYTES, selectReviewLearnings, validateReviewLearnings } from "./review-learnings-budget";

test("budget checks bytes, rejects oversized lessons, and accepts concise guidance", () => {
  validateReviewLearnings("# Learnings\n\n- Check ownership before reading tenant data.\n");
  assert.throws(() => validateReviewLearnings("界".repeat(MAX_REVIEW_LEARNINGS_BYTES / 2)), /UTF-8 bytes/);
  assert.throws(() => validateReviewLearnings("- " + "a".repeat(601)), /Each review lesson/);
});

test("legacy projection keeps complete applicable lessons and skips oversized entries", () => {
  const content = ["# Learnings", "- " + "old incident history ".repeat(1000), "- Keep common guidance.", "- [repo:acme/other] Other repo rule.", "- [repo:acme/app] Applicable rule."].join("\n\n");
  const selected = selectReviewLearnings(content, "acme/app");
  assert.match(selected, /Keep common guidance/);
  assert.match(selected, /Applicable rule/);
  assert.doesNotMatch(selected, /old incident|Other repo/);
  assert.ok(Buffer.byteLength(selected) <= MAX_REVIEW_LEARNINGS_BYTES);
});

test("many small lessons cannot overflow the prompt budget", () => {
  const selected = selectReviewLearnings(Array.from({ length: 1000 }, (_, i) => `- Lesson ${i}: ` + "bounded ".repeat(40)).join("\n\n"), "acme/app");
  assert.ok(Buffer.byteLength(selected) <= MAX_REVIEW_LEARNINGS_BYTES);
  assert.ok(selected.endsWith("bounded"));
});
