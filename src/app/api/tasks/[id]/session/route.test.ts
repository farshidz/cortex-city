import test from "node:test";
import assert from "node:assert/strict";

import { __testUtils } from "./route";

test("parseCodexLog prefers received_at over the session start fallback", () => {
  const content = [
    "--- Session started at 2026-04-22T03:39:58.000Z ---",
    JSON.stringify({
      type: "item.completed",
      received_at: "2026-04-22T03:40:10.000Z",
      item: {
        type: "command_execution",
        command: "echo hi",
        aggregated_output: "hi",
      },
    }),
  ].join("\n");

  const parsed = __testUtils.parseCodexLog(content, "2026-04-22T03:39:58.000Z");

  assert.ok(parsed);
  assert.equal(parsed.messages[0].timestamp, "2026-04-22T03:40:10.000Z");
});

test("parseCodexLog prefers event timestamps over received_at", () => {
  const content = JSON.stringify({
    type: "item.completed",
    timestamp: "2026-04-22T03:41:00.000Z",
    received_at: "2026-04-22T03:41:05.000Z",
    item: {
      type: "agent_message",
      text: '{"status":"completed","summary":"done","files_changed":[],"assumptions":[],"blockers":[],"next_steps":[]}',
    },
  });

  const parsed = __testUtils.parseCodexLog(content, "2026-04-22T03:39:58.000Z");

  assert.ok(parsed);
  assert.equal(parsed.messages[0].timestamp, "2026-04-22T03:41:00.000Z");
});
