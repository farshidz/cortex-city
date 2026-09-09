import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countersReset, readCodexRoundUsage, claudeRoundUsage } from "./review-run-telemetry";

function fixture(events: unknown[]) {
  const root = mkdtempSync(path.join(tmpdir(), "review-usage-"));
  mkdirSync(path.join(root, "sessions", "2026"), {recursive: true});
  writeFileSync(path.join(root, "sessions", "2026", "rollout-session-1.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return root;
}
const startedAt = Date.parse("2026-09-09T00:00:00Z");
const finishedAt = startedAt + 1000;
const event = (type: string, payload: object, offset = 100) => ({type, timestamp: new Date(startedAt + offset).toISOString(), payload});
const started = (turn_id: string, offset = 0) => event("event_msg", {type: "task_started", turn_id}, offset);
const usage = (response_id: string, input_tokens = 100, turn_id = "review", offset = 100) => event("token_usage_record", {thread_id: "session-1", turn_id, response_id, usage: {input_tokens, cached_input_tokens: 50, output_tokens: 10}}, offset);

test("native usage isolates this turn from previous reviews/Q&A and deduplicates responses", async () => {
  const root = fixture([started("qa", -200), usage("old", 9000, "qa", -100), started("review"), usage("a"), usage("a"), usage("b", 200), usage("late", 9000, "review", 2000)]);
  const measured = await readCodexRoundUsage("session-1", startedAt, finishedAt, root);
  assert.deepEqual(measured, {status: "native_request_usage", usage: {input_tokens: 300, cached_input_tokens: 100, output_tokens: 20}, turn_ids: ["review"], response_count: 2});
});

test("failed turns still retain consumed requests; missing or malformed usage is explicit", async () => {
  const failed = fixture([started("review"), usage("a"), event("event_msg", {type: "turn_aborted"})]);
  assert.equal((await readCodexRoundUsage("session-1", startedAt, finishedAt, failed)).usage?.input_tokens, 100);
  const invalid = fixture([started("review"), usage("a", 1)]);
  assert.equal((await readCodexRoundUsage("session-1", startedAt, finishedAt, invalid)).status, "invalid_records");
  const oldCLI = fixture([started("review"), event("event_msg", {type: "token_count", info: {total_token_usage: {input_tokens: 9000}}})]);
  assert.equal((await readCodexRoundUsage("session-1", startedAt, finishedAt, oldCLI)).usage, undefined);
  assert.equal((await readCodexRoundUsage(undefined, startedAt, finishedAt, oldCLI)).status, "missing_session");
  assert.equal(countersReset({input_tokens: 1000}, {input_tokens: 100}), true);
});


test("Claude invocation totals include cache reads and writes without treating writes as hits", () => {
  assert.deepEqual(claudeRoundUsage({input_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 30, output_tokens: 10}), {input_tokens: 100, cached_input_tokens: 50, output_tokens: 10});
  assert.equal(claudeRoundUsage({input_tokens: -1, output_tokens: 10}), undefined);
});


test("the analysis counts each run once and keeps unknown usage visible", () => {
  const root = mkdtempSync(path.join(tmpdir(), "review-report-"));
  const meta = {run_id: "a", group: "reuse", runtime: "codex", model: "test", effort: "medium", tier: 1, round: "review", started_at: "2026-09-09T00:00:00Z", deployment_revision: "abc", pr_url: "https://github.com/acme/widget/pull/1"};
  const completion = {...meta, event: "review_runtime_completed", usage: {input_tokens: 100, cached_input_tokens: 80, output_tokens: 10}, raw_usage: {input_tokens: 999999}, duration_ms: 200};
  writeFileSync(path.join(root, "run-events-2026-09-09.jsonl"), [{...meta, event: "review_started"}, completion, completion, {...meta, event: "review_saved", agent_review_status: "needs_author_changes"}, {...meta, run_id: "b", event: "review_launch_failed", error: "spawn failed"}].map((event) => JSON.stringify(event)).join("\n"));
  const report = JSON.parse(execFileSync(process.execPath, [path.join(process.cwd(), "scripts/analyze-review-usage.mjs"), root, "2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z"], {encoding: "utf8"}));
  assert.equal(report.prs[0].input_tokens, 100);
  assert.equal(report.prs[0].cached_input_fraction, 0.8);
  assert.equal(report.prs[0].rounds, 2);
  assert.equal(report.prs[0].unknown_usage_rounds, 1);
  assert.equal(report.prs[0].failed_rounds, 1);
});
