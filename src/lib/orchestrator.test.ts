import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { OrchestratorConfig, Task } from "./types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ORCHESTRATOR_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/orchestrator.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));
}

function runOrchestratorScript(
  workspace: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { getOrchestrator } from ${JSON.stringify(ORCHESTRATOR_MODULE_URL)};`,
        "(async () => {",
        body,
        "})().catch((error) => {",
        '  console.error(error);',
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
      env,
    }
  );

  return JSON.parse(output);
}

function writeConfig(workspace: string, overrides: Partial<OrchestratorConfig> = {}) {
  const config: OrchestratorConfig = {
    max_parallel_sessions: 10,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {},
    ...overrides,
  };

  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(config, null, 2)
  );
}

function writeTasks(workspace: string, tasks: Task[]) {
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "tasks.json"),
    JSON.stringify(tasks, null, 2)
  );
}

function writeWorkerState(workspace: string, state: Record<string, unknown>) {
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "orchestrator-state.json"),
    JSON.stringify(state, null, 2)
  );
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Investigate session counts",
    description: "Keep orchestrator status aligned with running tasks",
    status: "in_progress",
    agent: "cortex-city-swe",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

test("getStatus derives active session count from live task pids instead of stale worker state", () => {
  const workspace = createTempWorkspace();
  writeConfig(workspace);
  writeTasks(workspace, [
    sampleTask({
      id: "live-task",
      current_run_pid: process.pid,
      session_id: "live-session",
      last_run_at: "2026-04-15T00:05:00.000Z",
    }),
  ]);
  writeWorkerState(workspace, {
    running: true,
    active_sessions: 2,
    last_poll_at: "2026-04-15T00:10:00.000Z",
    last_heartbeat_at: "2026-04-15T00:10:05.000Z",
    started_at: "2026-04-15T00:00:00.000Z",
    poll_started_at: null,
    poll_finished_at: "2026-04-15T00:10:00.000Z",
    poll_in_progress: false,
    pid: process.pid,
  });

  const result = runOrchestratorScript(
    workspace,
    `
      const orchestrator = getOrchestrator();
      console.log(JSON.stringify(orchestrator.getStatus()));
    `
  );

  assert.equal(result.running, true);
  assert.equal(result.healthy, true);
  assert.equal(result.worker_healthy, true);
  assert.equal(result.autostart_enabled, false);
  assert.equal(result.active_sessions, 1);
  assert.equal(result.max_sessions, 10);
});

test("getActiveSessions filters out dead task pids", () => {
  const workspace = createTempWorkspace();
  writeConfig(workspace);
  writeTasks(workspace, [
    sampleTask({
      id: "dead-task",
      current_run_pid: 999999,
      session_id: "dead-session",
      last_run_at: "2026-04-15T00:01:00.000Z",
    }),
    sampleTask({
      id: "live-task",
      current_run_pid: process.pid,
      session_id: "live-session",
      last_run_at: "2026-04-15T00:02:00.000Z",
    }),
  ]);
  writeWorkerState(workspace, {
    running: true,
    active_sessions: 2,
    last_poll_at: null,
    last_heartbeat_at: null,
    started_at: null,
    poll_started_at: null,
    poll_finished_at: null,
    poll_in_progress: false,
    pid: process.pid,
  });

  const result = runOrchestratorScript(
    workspace,
    `
      const orchestrator = getOrchestrator();
      console.log(JSON.stringify(orchestrator.getActiveSessions()));
    `
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].task_id, "live-task");
  assert.equal(result[0].pid, process.pid);
  assert.equal(result[0].session_id, "live-session");
});

test("getStatus reports stopped when the worker pid is stale", () => {
  const workspace = createTempWorkspace();
  writeConfig(workspace);
  writeTasks(workspace, []);
  writeWorkerState(workspace, {
    running: true,
    active_sessions: 0,
    last_poll_at: "2026-04-15T00:10:00.000Z",
    last_heartbeat_at: "2026-04-15T00:10:05.000Z",
    started_at: "2026-04-15T00:00:00.000Z",
    poll_started_at: null,
    poll_finished_at: "2026-04-15T00:10:00.000Z",
    poll_in_progress: false,
    pid: 999999,
  });

  const result = runOrchestratorScript(
    workspace,
    `
      const orchestrator = getOrchestrator();
      console.log(JSON.stringify(orchestrator.getStatus()));
    `
  );

  assert.equal(result.running, false);
  assert.equal(result.healthy, false);
  assert.equal(result.worker_healthy, false);
  assert.equal(result.autostart_enabled, false);
});

test("getStatus reports autostart when explicitly enabled", () => {
  const workspace = createTempWorkspace();
  writeConfig(workspace);
  writeTasks(workspace, []);
  writeWorkerState(workspace, {
    running: false,
    active_sessions: 0,
    last_poll_at: null,
    last_heartbeat_at: null,
    started_at: null,
    poll_started_at: null,
    poll_finished_at: null,
    poll_in_progress: false,
    pid: 999999,
  });

  const result = runOrchestratorScript(
    workspace,
    `
      const orchestrator = getOrchestrator();
      console.log(JSON.stringify(orchestrator.getStatus()));
    `,
    {
      ...process.env,
      CORTEX_ENABLE_WORKER_AUTOSTART: "true",
    }
  );

  assert.equal(result.autostart_enabled, true);
  assert.equal(result.healthy, false);
});
