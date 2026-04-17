import test from "node:test";
import assert from "node:assert/strict";

import {
  formatEffortLabel,
  getDefaultEffortForRuntime,
  getDefaultModelForRuntime,
  getEffortOptions,
  getPermissionOptions,
  normalizeEffort,
  normalizeModel,
  normalizePermissionMode,
  resolveTaskEffort,
  resolveTaskModel,
  resolveTaskRuntime,
} from "./runtime-config";
import type { OrchestratorConfig, Task } from "./types";

function sampleConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium",
    agents: {},
    ...overrides,
  };
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Cover runtime defaults",
    description: "Verify runtime-specific normalization helpers",
    status: "open",
    agent: "cortex-city-swe",
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

test("getPermissionOptions returns runtime-specific permission values", () => {
  assert.deepEqual(
    getPermissionOptions("claude").map((option) => option.value),
    ["bypassPermissions", "acceptEdits", "default"]
  );
  assert.deepEqual(
    getPermissionOptions("codex").map((option) => option.value),
    ["default", "yolo"]
  );
});

test("normalizePermissionMode prefers valid values, then valid fallbacks, then the runtime default", () => {
  assert.equal(normalizePermissionMode("claude", "acceptEdits", "default"), "acceptEdits");
  assert.equal(normalizePermissionMode("codex", "acceptEdits", "yolo"), "yolo");
  assert.equal(normalizePermissionMode("codex", "acceptEdits", "acceptEdits"), "default");
});

test("getDefaultModelForRuntime and getDefaultEffortForRuntime read runtime-specific defaults", () => {
  const config = sampleConfig();

  assert.equal(getDefaultModelForRuntime(config, "claude"), "claude-sonnet-4-6");
  assert.equal(getDefaultModelForRuntime(config, "codex"), "gpt-5.4");
  assert.equal(getDefaultEffortForRuntime(config, "claude"), "high");
  assert.equal(getDefaultEffortForRuntime(config, "codex"), "medium");
});

test("normalizeModel trims values and falls back when needed", () => {
  assert.equal(normalizeModel("  gpt-5.5  ", "gpt-5.4"), "gpt-5.5");
  assert.equal(normalizeModel("   ", "  claude-opus  "), "claude-opus");
  assert.equal(normalizeModel(undefined, "   "), undefined);
});

test("getEffortOptions and normalizeEffort keep runtimes isolated", () => {
  const config = sampleConfig();

  assert.deepEqual(
    getEffortOptions("claude").map((option) => option.value),
    ["low", "medium", "high", "max"]
  );
  assert.deepEqual(
    getEffortOptions("codex").map((option) => option.value),
    ["none", "low", "medium", "high", "xhigh"]
  );
  assert.equal(normalizeEffort("codex", "xhigh", config), "xhigh");
  assert.equal(normalizeEffort("codex", "max", config), "medium");
  assert.equal(normalizeEffort("claude", "xhigh", config), "high");
  assert.equal(normalizeEffort("claude", undefined, sampleConfig({ default_claude_effort: undefined })), undefined);
});

test("resolveTaskRuntime, resolveTaskModel, and resolveTaskEffort honor task overrides first", () => {
  const config = sampleConfig();
  const claudeTask = sampleTask();
  const codexTask = sampleTask({
    agent_runner: "codex",
    model: "  gpt-5.5  ",
    effort: "xhigh",
  });

  assert.equal(resolveTaskRuntime(claudeTask, config), "claude");
  assert.equal(resolveTaskModel(claudeTask, config), "claude-sonnet-4-6");
  assert.equal(resolveTaskEffort(claudeTask, config), "high");

  assert.equal(resolveTaskRuntime(codexTask, config), "codex");
  assert.equal(resolveTaskModel(codexTask, config), "gpt-5.5");
  assert.equal(resolveTaskEffort(codexTask, config), "xhigh");
});

test("resolveTaskModel and resolveTaskEffort ignore invalid task overrides for the selected runtime", () => {
  const config = sampleConfig({ default_agent_runner: "codex" });
  const task = sampleTask({
    agent_runner: "codex",
    model: "   ",
    effort: "max",
  });

  assert.equal(resolveTaskModel(task, config), "gpt-5.4");
  assert.equal(resolveTaskEffort(task, config), "medium");
});

test("formatEffortLabel formats special and generic effort labels", () => {
  assert.equal(formatEffortLabel(undefined), "CLI default");
  assert.equal(formatEffortLabel("xhigh"), "Extra High");
  assert.equal(formatEffortLabel("medium"), "Medium");
});
