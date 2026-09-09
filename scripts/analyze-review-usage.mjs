#!/usr/bin/env node
// node scripts/analyze-review-usage.mjs LOG_DIRECTORY START_ISO END_ISO
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const [directory = "logs", start, end] = process.argv.slice(2);
const from = Date.parse(start), until = Date.parse(end);
if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) {
  throw new Error("Usage: node scripts/analyze-review-usage.mjs LOG_DIRECTORY START_ISO END_ISO");
}
const runs = new Map();
let malformed = 0;
for (const file of readdirSync(directory).filter((name) => /^run-events-.*\.jsonl$/.test(name)).sort()) {
  for (const line of readFileSync(path.join(directory, file), "utf8").split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { malformed++; continue; }
    if (!event.event?.startsWith("review_") || !event.run_id) continue;
    const run = runs.get(event.run_id) || {};
    run[event.event] = event;
    runs.set(event.run_id, run);
  }
}
const groups = new Map(), prs = new Map();
function add(map, key, meta, completed, saved) {
  const row = map.get(key) || {key, rounds: 0, measured_rounds: 0, unknown_usage_rounds: 0, incomplete_rounds: 0, failed_rounds: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0, verdicts: {}};
  row.rounds++;
  if (!completed) row.incomplete_rounds++;
  if (completed?.runtime_failed || saved?.error || meta.event === "review_launch_failed") row.failed_rounds++;
  if (completed?.usage) {
    row.measured_rounds++;
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens"]) row[field] += completed.usage[field];
  } else row.unknown_usage_rounds++;
  row.duration_ms += completed?.duration_ms || 0;
  if (saved?.agent_review_status) row.verdicts[saved.agent_review_status] = (row.verdicts[saved.agent_review_status] || 0) + 1;
  row.cached_input_fraction = row.input_tokens ? row.cached_input_tokens / row.input_tokens : null;
  map.set(key, row);
}
for (const run of runs.values()) {
  const meta = run.review_launch_failed || run.review_started || run.review_launch_attempt;
  if (!meta || !["fresh", "reuse"].includes(meta.group) || Date.parse(meta.started_at) < from || Date.parse(meta.started_at) >= until) continue;
  const completed = run.review_runtime_completed;
  const outcome = run.review_completion_failed || run.review_saved;
  const key = [meta.deployment_revision, meta.group, meta.runtime, meta.model, meta.effort, meta.tier, meta.round, meta.resumed ? "resumed" : "fresh", meta.had_prior_summary ? "followup" : "initial"].join("/");
  add(groups, key, meta, completed, outcome);
  add(prs, `${meta.deployment_revision}/${meta.group}/${meta.pr_url}`, meta, completed, outcome);
}
console.log(JSON.stringify({start, end, malformed_lines: malformed, usage_scope: "runtime thread; native per-request tokens", groups: [...groups.values()], prs: [...prs.values()]}, null, 2));
