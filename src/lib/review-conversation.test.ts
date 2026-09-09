import test from "node:test";
import assert from "node:assert/strict";
import { conversationKey, conversationPrompt, MAX_CONVERSATION_PROMPT_BYTES, mergeConversationCoverage, parseConversationCoverage, unhandledConversation, type ReviewConversationItem } from "./review-conversation";

function item(id: number, body: string, updated_at = "2026-09-08T08:59:03Z"): ReviewConversationItem {
  return { id, body, updated_at, surface: "issue", key: conversationKey("issue", id, body) };
}

test("a handled pre-start question does not repeat inside the old skew window", () => {
  const question = item(1, "Can you explain?");
  const legacy = { last_conversation_seen_at: "2026-09-08T08:58:24Z" };
  const handled_conversation_keys = mergeConversationCoverage(legacy, [question], [question], [question.key]);
  assert.deepEqual(unhandledConversation([question], { handled_conversation_keys }), []);
});

test("mid-run acknowledgements preserve unread arrivals and edited versions", () => {
  const before = item(1, "Question");
  const handledDuringRun = item(2, "Acknowledged");
  const unread = item(3, "Late question");
  const edited = item(1, "Changed question");
  const handled_conversation_keys = mergeConversationCoverage({ handled_conversation_keys: [] }, [before], [edited, handledDuringRun, unread], [before.key, handledDuringRun.key, "invented"]);
  assert.deepEqual(unhandledConversation([edited, handledDuringRun, unread], { handled_conversation_keys }), [edited, unread]);
  assert.ok(!handled_conversation_keys.includes("invented"));
});

test("legacy migration acknowledges old versions but includes new edits", () => {
  const old = item(1, "Old", "2026-09-08T08:00:00Z");
  const edited = item(2, "Edited", "2026-09-08T09:00:00Z");
  const state = { last_conversation_seen_at: "2026-09-08T08:30:00Z" };
  assert.deepEqual(unhandledConversation([old, edited], state), [edited]);
  const keys = mergeConversationCoverage(state, [old, edited], [old, edited], []);
  assert.deepEqual(keys, [old.key]);
});

test("coverage parsing strips internal metadata and ignores malformed receipts", () => {
  const key = item(1, "Question").key;
  const parsed = parseConversationCoverage(`Agent status: replied\n<!-- cortex-city-handled: ${JSON.stringify([key, 3])} -->`);
  assert.deepEqual(parsed, { text: "Agent status: replied", keys: [key] });
  assert.deepEqual(parseConversationCoverage("Done\n<!-- cortex-city-handled: invalid -->"), { text: "Done", keys: [] });
  assert.notEqual(conversationKey("review", 1, "OK", "APPROVED"), conversationKey("review", 1, "OK", "DISMISSED"));
  assert.notEqual(conversationKey("issue", 1, "OK"), conversationKey("review_comment", 1, "OK"));
});


test("legacy migration leaves review state versions pending without a trustworthy edit clock", () => {
  const review = {...item(1, "Previously approved", "2026-09-01T00:00:00Z"), surface: "review" as const, state: "DISMISSED"};
  assert.deepEqual(unhandledConversation([review], {last_conversation_seen_at: "2026-09-08T00:00:00Z"}), [review]);
});

test("large conversations are batched with bounded input and an unhandled remainder", () => {
  const pending = Array.from({length: 1000}, (_, id) => item(id, "界".repeat(30_000)));
  const prompt = conversationPrompt(pending);
  assert.ok(Buffer.byteLength(prompt) <= MAX_CONVERSATION_PROMPT_BYTES);
  const batch = JSON.parse(prompt.split(/<unhandled_conversation[^>]*>\n/)[1].split("\n</unhandled_conversation>")[0]);
  assert.ok(batch.length > 0 && batch.length <= 50);
  assert.equal(batch[0].body_omitted, true);
  const escaped = conversationPrompt([item(1, "\u0000".repeat(7500))]);
  assert.ok(Buffer.byteLength(escaped) <= MAX_CONVERSATION_PROMPT_BYTES);
  assert.match(escaped, /"body_omitted":true/);
  const handled_conversation_keys = mergeConversationCoverage(undefined, pending, pending, batch.map((entry: {key: string}) => entry.key));
  const remainder = unhandledConversation(pending, {handled_conversation_keys});
  assert.equal(remainder.length, pending.length - batch.length);
  assert.equal(remainder[0].key, pending[batch.length].key);
});

test("coverage compaction drops obsolete edit hashes only with a complete snapshot", () => {
  let state = {handled_conversation_keys: [] as string[]};
  for (let revision = 0; revision < 100; revision++) {
    const current = item(1, `Revision ${revision}`);
    state = {handled_conversation_keys: mergeConversationCoverage(state, [current], [current], [current.key])};
    assert.deepEqual(state.handled_conversation_keys, [current.key]);
  }
  const next = item(1, "Next");
  const preserved = mergeConversationCoverage(state, [next], undefined, [next.key]);
  assert.equal(preserved.length, 2);
});
