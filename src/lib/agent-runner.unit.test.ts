// In-process unit tests for agent-runner __testUtils helpers. Each call here
// runs in the c8-instrumented main test process so subprocess coverage gaps
// don't hide these functions from the coverage report.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { __testUtils } from "./agent-runner";
import type { ClaudeRunResult, Task } from "./types";

const {
  appendToBoundedTextBuffer,
  buildCodexResult,
  buildModelArgs,
  buildPermissionArgs,
  buildRepoRemoteUrl,
  buildUsageAccounting,
  computeCodexUsageDelta,
  createCodexResultAccumulator,
  flushCodexEventBuffer,
  formatCodexEventForTranscript,
  formatStructuredAgentMessage,
  formatTranscriptHeading,
  getCodexEventTimestamp,
  getExecErrorMessage,
  getGitHubRepoSlug,
  isBranchCheckedOutError,
  parseCodexResult,
  resolveAgentWorkingDirectory,
  sanitizeManagedRepoName,
  shouldClearCompletedRunPid,
  slugify,
  updateCodexResultAccumulator,
  withCodexReceivedAt,
} = __testUtils;

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Cover internals",
    description: "Sample",
    status: "open",
    agent: "cortex-city-swe",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

test("buildPermissionArgs covers every runtime/mode combination", () => {
  assert.deepEqual(buildPermissionArgs("claude", "default"), [
    "--permission-mode",
    "default",
  ]);
  assert.deepEqual(buildPermissionArgs("claude", "yolo"), [
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.deepEqual(buildPermissionArgs("codex", "bypassPermissions"), [
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.deepEqual(buildPermissionArgs("codex", "default"), ["--full-auto"]);
});

test("buildModelArgs respects runtime + task + config", () => {
  const config = {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions" as const,
    default_agent_runner: "claude" as const,
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high" as const,
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium" as const,
    agents: {},
  };
  assert.deepEqual(
    buildModelArgs(
      "claude",
      { model: "claude-opus-4-7", effort: "max" },
      config
    ),
    ["--model", "claude-opus-4-7", "--effort", "max"]
  );
  assert.deepEqual(buildModelArgs("codex", {}, config), [
    "--model",
    "gpt-5.4",
    "-c",
    'model_reasoning_effort="medium"',
  ]);
});

test("appendToBoundedTextBuffer keeps the tail when the cap is exceeded", () => {
  const buf: { value: string; truncated: boolean } = {
    value: "",
    truncated: false,
  };
  appendToBoundedTextBuffer(buf, "", 10);
  assert.equal(`${buf.value}`, "");

  appendToBoundedTextBuffer(buf, "abcdef", 10);
  assert.equal(`${buf.value}`, "abcdef");
  assert.equal(buf.truncated, false);

  appendToBoundedTextBuffer(buf, "ghijklmnop", 10);
  assert.equal(`${buf.value}`.length, 10);
  assert.equal(buf.truncated, true);
  // Tail wins.
  assert.equal(`${buf.value}`, "ghijklmnop");
});

test("parseCodexResult assembles the structured payload from a JSONL stream", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thr-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: '{"status":"completed","summary":"ok","pr_url":"","branch_name":"","files_changed":[],"assumptions":[],"blockers":[],"next_steps":[],"tool_calls":null}' },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 0 },
    }),
    "",
  ].join("\n");

  const result = parseCodexResult(stdout);
  assert.equal(result.session_id, "thr-1");
  assert.equal(result.usage?.input_tokens, 11);
  assert.equal(result.usage?.output_tokens, 22);
  assert.ok(result.structured_output);
  assert.equal(result.structured_output.status, "completed");
});

test("parseCodexResult tolerates malformed lines", () => {
  // Only the well-formed event should land; the malformed line is skipped.
  const stdout = [
    "not-json",
    JSON.stringify({ type: "thread.started", thread_id: "thr-9" }),
  ].join("\n");
  const result = parseCodexResult(stdout);
  assert.equal(result.session_id, "thr-9");
});

test("buildUsageAccounting computes per-run + cumulative token deltas", () => {
  const result: ClaudeRunResult = {
    type: "result",
    subtype: "print",
    is_error: false,
    duration_ms: 100,
    result: "ok",
    session_id: "sess-1",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    usage: {
      input_tokens: 50,
      output_tokens: 30,
      cache_read_input_tokens: 5,
    },
  };
  const current = sampleTask({
    total_input_tokens: 10,
    total_cached_input_tokens: 1,
    total_output_tokens: 5,
  });
  const accounting = buildUsageAccounting("claude", result, current);
  assert.equal(accounting.inputTokens, 50);
  assert.equal(accounting.outputTokens, 30);
  assert.equal(accounting.cachedInputTokens, 5);
  assert.equal(accounting.updates.total_input_tokens, 60);
  assert.equal(accounting.updates.total_cached_input_tokens, 6);
  assert.equal(accounting.updates.total_output_tokens, 35);
  assert.equal(accounting.updates.last_run_input_tokens, 50);
});

test("buildUsageAccounting subtracts Codex cumulative usage for same-session runs", () => {
  const result: ClaudeRunResult = {
    type: "codex",
    subtype: "exec",
    is_error: false,
    duration_ms: 100,
    result: "",
    session_id: "thr-1",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    usage: {
      input_tokens: 200,
      output_tokens: 100,
      cache_read_input_tokens: 50,
    },
  };
  const current = sampleTask({
    codex_usage_session_id: "thr-1",
    codex_cumulative_input_tokens: 150,
    codex_cumulative_cached_input_tokens: 30,
    codex_cumulative_output_tokens: 60,
    total_input_tokens: 150,
    total_cached_input_tokens: 30,
    total_output_tokens: 60,
  });
  const accounting = buildUsageAccounting("codex", result, current);
  // Delta for the new turn only.
  assert.equal(accounting.inputTokens, 50);
  assert.equal(accounting.cachedInputTokens, 20);
  assert.equal(accounting.outputTokens, 40);
  assert.equal(accounting.updates.codex_usage_session_id, "thr-1");
  assert.equal(accounting.updates.codex_cumulative_input_tokens, 200);
});

test("buildUsageAccounting treats lower same-session Codex usage as stale", () => {
  const result: ClaudeRunResult = {
    type: "codex",
    subtype: "exec",
    is_error: false,
    duration_ms: 100,
    result: "",
    session_id: "thr-1",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    usage: {
      input_tokens: 180,
      output_tokens: 95,
      cache_read_input_tokens: 40,
    },
  };
  const current = sampleTask({
    codex_usage_session_id: "thr-1",
    codex_cumulative_input_tokens: 200,
    codex_cumulative_cached_input_tokens: 50,
    codex_cumulative_output_tokens: 100,
    total_input_tokens: 200,
    total_cached_input_tokens: 50,
    total_output_tokens: 100,
  });
  const accounting = buildUsageAccounting("codex", result, current);
  assert.equal(accounting.inputTokens, 0);
  assert.equal(accounting.cachedInputTokens, 0);
  assert.equal(accounting.outputTokens, 0);
  assert.equal(accounting.updates.last_run_input_tokens, 0);
  assert.equal(accounting.updates.total_input_tokens, 200);
  assert.equal(accounting.updates.total_cached_input_tokens, 50);
  assert.equal(accounting.updates.total_output_tokens, 100);
  assert.equal(accounting.updates.codex_cumulative_input_tokens, 200);
  assert.equal(accounting.updates.codex_cumulative_cached_input_tokens, 50);
  assert.equal(accounting.updates.codex_cumulative_output_tokens, 100);
});

test("buildUsageAccounting resets when a new Codex session starts", () => {
  const result: ClaudeRunResult = {
    type: "codex",
    subtype: "exec",
    is_error: false,
    duration_ms: 100,
    result: "",
    session_id: "thr-2",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    usage: {
      input_tokens: 50,
      output_tokens: 25,
      cache_read_input_tokens: 5,
    },
  };
  const current = sampleTask({
    codex_usage_session_id: "thr-1", // different session
    codex_cumulative_input_tokens: 9999,
  });
  const accounting = buildUsageAccounting("codex", result, current);
  // New session — no delta subtraction, raw values land.
  assert.equal(accounting.inputTokens, 50);
  assert.equal(accounting.outputTokens, 25);
});

test("resolveAgentWorkingDirectory accepts subdirs and rejects escapes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workdir-"));
  const sub = path.join(root, "service");
  mkdirSync(sub);

  assert.equal(resolveAgentWorkingDirectory(root, "."), path.resolve(root));
  assert.equal(
    resolveAgentWorkingDirectory(root, "service"),
    path.resolve(sub)
  );
  assert.throws(() =>
    resolveAgentWorkingDirectory(root, "../escape")
  );
  assert.throws(() =>
    resolveAgentWorkingDirectory(root, "/absolute/path")
  );
  assert.throws(() =>
    resolveAgentWorkingDirectory(root, "missing-dir")
  );
});

test("buildRepoRemoteUrl converts owner/repo to SSH and passes through URLs", () => {
  assert.equal(
    buildRepoRemoteUrl("acme/widget"),
    "git@github.com:acme/widget.git"
  );
  assert.equal(
    buildRepoRemoteUrl("acme/widget.git"),
    "git@github.com:acme/widget.git"
  );
  assert.equal(
    buildRepoRemoteUrl("git@github.com:acme/widget.git"),
    "git@github.com:acme/widget.git"
  );
  assert.equal(
    buildRepoRemoteUrl("https://github.com/acme/widget.git"),
    "https://github.com/acme/widget.git"
  );
});

test("getGitHubRepoSlug only recognises owner/repo strings", () => {
  assert.equal(getGitHubRepoSlug("acme/widget"), "acme/widget");
  assert.equal(getGitHubRepoSlug("acme/widget.git"), "acme/widget");
  assert.equal(getGitHubRepoSlug("git@github.com:acme/widget.git"), undefined);
  assert.equal(getGitHubRepoSlug("plain-name"), undefined);
});

test("sanitizeManagedRepoName replaces unsafe characters and caps length", () => {
  assert.equal(sanitizeManagedRepoName("acme/widget"), "acme-widget");
  assert.equal(sanitizeManagedRepoName("acme/widget.git"), "acme-widget");
  assert.equal(sanitizeManagedRepoName(""), "repo");
  // Long input is truncated.
  assert.ok(sanitizeManagedRepoName("a".repeat(200)).length <= 80);
});

test("slugify produces short, dash-separated, lowercase identifiers", () => {
  assert.equal(slugify("Add Fizzbuzz Tests", 20), "add-fizzbuzz-tests");
  assert.equal(slugify("---weird---", 20), "weird");
  assert.equal(slugify("Lots of Words Here Indeed", 10), "lots-of-wo");
});

test("getExecErrorMessage prefers stderr over message and tolerates non-objects", () => {
  assert.equal(getExecErrorMessage(undefined), "");
  assert.equal(getExecErrorMessage("oops"), "oops");
  const err: Error & { stderr?: string } = new Error("boom");
  err.stderr = " stderr output ";
  assert.match(getExecErrorMessage(err), /stderr output/);
  assert.match(getExecErrorMessage(err), /boom/);
});

test("isBranchCheckedOutError matches git's known phrasing", () => {
  assert.equal(
    isBranchCheckedOutError(new Error("fatal: 'feat' is already checked out")),
    true
  );
  assert.equal(
    isBranchCheckedOutError({ stderr: "is already used by worktree" }),
    true
  );
  assert.equal(isBranchCheckedOutError(new Error("unrelated")), false);
});

test("shouldClearCompletedRunPid only clears the pid owned by the completed run", () => {
  assert.equal(
    shouldClearCompletedRunPid(sampleTask({ current_run_pid: 123 }), 123),
    true
  );
  assert.equal(
    shouldClearCompletedRunPid(sampleTask({ current_run_pid: 456 }), 123),
    false
  );
  assert.equal(
    shouldClearCompletedRunPid(sampleTask({ current_run_pid: 456 })),
    true
  );
  assert.equal(shouldClearCompletedRunPid(sampleTask(), 123), true);
});

test("computeCodexUsageDelta returns the cumulative value when sessions differ", () => {
  assert.equal(computeCodexUsageDelta(100, 30, true), 70);
  assert.equal(computeCodexUsageDelta(100, 30, false), 100);
  // Lower same-session counters are stale/out-of-order cumulative reports.
  assert.equal(computeCodexUsageDelta(20, 30, true), 0);
});

test("Codex event helpers stamp received_at and pick the better timestamp", () => {
  const original = { type: "thread.started", thread_id: "t" };
  const stamped = withCodexReceivedAt(original);
  assert.ok(stamped.received_at);
  assert.equal(getCodexEventTimestamp({ type: "x" }), undefined);
  assert.equal(
    getCodexEventTimestamp({ type: "x", timestamp: "T0" }),
    "T0"
  );
  assert.equal(
    getCodexEventTimestamp({ type: "x", received_at: "R0" }),
    "R0"
  );
});

test("Codex accumulators feed buildCodexResult", () => {
  const accumulator = createCodexResultAccumulator();
  // Empty accumulator → empty result with fallback.
  const empty = buildCodexResult(accumulator, "fallback");
  assert.equal(empty.result, "fallback");

  updateCodexResultAccumulator(accumulator, {
    type: "thread.started",
    thread_id: "thr-1",
  });
  updateCodexResultAccumulator(accumulator, {
    type: "item.completed",
    item: { type: "agent_message", text: "the answer" },
  });
  updateCodexResultAccumulator(accumulator, {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 },
  });
  const built = buildCodexResult(accumulator);
  assert.equal(built.session_id, "thr-1");
  assert.equal(built.result, "the answer");
  assert.equal(built.usage?.input_tokens, 1);
  assert.equal(built.usage?.output_tokens, 2);
});

test("flushCodexEventBuffer reassembles split JSONL chunks", () => {
  const events: Array<{ type: string }> = [];
  const remainder = flushCodexEventBuffer(
    '{"type":"thread.started","thread_id":"t"}\n{"type":"x"}',
    "",
    (event) => events.push(event)
  );
  // First two lines fire; the third (no trailing newline) is the carry.
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "thread.started");
  assert.equal(remainder, '{"type":"x"}');

  // Feeding a newline flushes the carry.
  const more: Array<{ type: string }> = [];
  flushCodexEventBuffer("\n", remainder, (event) => more.push(event));
  assert.equal(more[0]?.type, "x");
});

test("formatStructuredAgentMessage renders agent report payloads as plain text", () => {
  const payload = JSON.stringify({
    status: "completed",
    summary: "all good",
    pr_url: "https://github.com/acme/widget/pull/1",
    branch_name: "agent/x",
    files_changed: ["a", "b"],
    assumptions: ["one"],
    blockers: [],
    next_steps: ["next"],
  });
  const rendered = formatStructuredAgentMessage(payload);
  assert.match(rendered, /Status: completed/);
  assert.match(rendered, /Summary: all good/);
  assert.match(rendered, /Files changed: a, b/);
  // Non-JSON input passes through verbatim.
  assert.equal(formatStructuredAgentMessage("plain text"), "plain text");
});

test("formatCodexEventForTranscript handles every interesting event kind", () => {
  assert.match(
    formatTranscriptHeading("USER", "2026-05-01T00:00:00Z", "(initial)") ?? "",
    /USER/
  );
  assert.equal(formatCodexEventForTranscript({ type: "unknown" }), null);
  const prompt = formatCodexEventForTranscript({
    type: "prompt",
    mode: "initial",
    timestamp: "2026-05-01T00:00:00Z",
    content: "hello",
  });
  assert.ok(prompt && /USER/.test(prompt));

  const thread = formatCodexEventForTranscript({
    type: "thread.started",
    thread_id: "thr-1",
    timestamp: "2026-05-01T00:00:01Z",
  });
  assert.ok(thread && /Session started: thr-1/.test(thread));

  const msg = formatCodexEventForTranscript({
    type: "item.completed",
    item: { type: "agent_message", text: "raw text" },
    timestamp: "T",
  });
  assert.ok(msg && /CODEX/.test(msg));

  const cmd = formatCodexEventForTranscript({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "file\n",
    },
    timestamp: "T",
  });
  assert.ok(cmd && /\$ ls -la/.test(cmd));

  const err = formatCodexEventForTranscript({
    type: "error",
    message: "kaboom",
    timestamp: "T",
  });
  assert.ok(err && /kaboom/.test(err));
});
