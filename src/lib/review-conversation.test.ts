import test from "node:test";
import assert from "node:assert/strict";
import { conversationKey, mergeConversationCoverage, parseConversationCoverage, unhandledConversation, type ReviewConversationItem } from "./review-conversation";

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
  const keys = mergeConversationCoverage(state, [old, edited], [], []);
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
