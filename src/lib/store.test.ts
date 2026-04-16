import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { OrchestratorConfig, Task } from "./types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const STORE_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, "src/lib/store.ts")).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "store-test-"));
}

function runStoreScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as store from ${JSON.stringify(STORE_MODULE_URL)};`,
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
    }
  );

  return JSON.parse(output);
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add tests",
    description: "Add comprehensive unit tests",
    status: "open",
    agent: "cortex-city-swe",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

test("readConfig creates defaults when no config file exists", () => {
  const workspace = createTempWorkspace();
  const config = runStoreScript(
    workspace,
    "console.log(JSON.stringify(store.readConfig()));"
  );

  assert.deepEqual(config, {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {},
  });

  const configFile = path.join(workspace, ".cortex", "config.json");
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf-8")), config);
});

test("readConfig migrates legacy runner and permission fields", () => {
  const workspace = createTempWorkspace();
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(
      {
        max_parallel_sessions: 4,
        poll_interval_seconds: 15,
        agent_runner: "codex",
        permission_mode: "acceptEdits",
      },
      null,
      2
    )
  );

  const config = runStoreScript(
    workspace,
    "console.log(JSON.stringify(store.readConfig()));"
  );

  assert.deepEqual(config, {
    max_parallel_sessions: 4,
    poll_interval_seconds: 15,
    default_permission_mode: "acceptEdits",
    default_agent_runner: "codex",
    agents: {},
    permission_mode: "acceptEdits",
  });
});

test("task CRUD helpers persist updates and refresh timestamps", () => {
  const workspace = createTempWorkspace();
  const task = sampleTask();
  const result = runStoreScript(
    workspace,
    `
      const task = ${JSON.stringify(task)};
      const created = await store.createTask(task);
      const updated = await store.updateTask("task-1", {
        status: "in_review",
        pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/123",
      });
      const fetched = await store.getTask("task-1");
      await store.deleteTask("task-1");
      console.log(
        JSON.stringify({
          created,
          updated,
          fetched,
          remaining: store.readTasks(),
        })
      );
    `
  );

  assert.equal(result.created.id, "task-1");
  assert.equal(result.updated.status, "in_review");
  assert.equal(
    result.updated.pr_url,
    "https://github.com/farshidz/marqo-cortex-city/pull/123"
  );
  assert.notEqual(result.updated.updated_at, "2026-04-15T00:00:00.000Z");
  assert.deepEqual(result.fetched, result.updated);
  assert.deepEqual(result.remaining, []);
});

test("writeConfig persists the supplied configuration", () => {
  const workspace = createTempWorkspace();
  const config: OrchestratorConfig = {
    max_parallel_sessions: 5,
    poll_interval_seconds: 10,
    default_permission_mode: "yolo",
    default_agent_runner: "codex",
    agents: {
      "cortex-city-swe": {
        name: "Cortex City SWE",
        repo_slug: "farshidz/marqo-cortex-city",
        repo_path: "/tmp/repo",
        prompt_file: "prompts/agents/cortex-city-swe.md",
        default_branch: "main",
        description: "Owns the control panel and orchestrator worker.",
      },
    },
  };

  const persisted = runStoreScript(
    workspace,
    `
      const config = ${JSON.stringify(config)};
      await store.writeConfig(config);
      console.log(JSON.stringify(store.readConfig()));
    `
  );

  assert.deepEqual(persisted, config);
});

test("writeConfig persists runtime-specific model and effort defaults", () => {
  const workspace = createTempWorkspace();
  const config: OrchestratorConfig = {
    max_parallel_sessions: 3,
    poll_interval_seconds: 20,
    default_permission_mode: "default",
    default_agent_runner: "claude",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium",
    agents: {},
  };

  const persisted = runStoreScript(
    workspace,
    `
      const config = ${JSON.stringify(config)};
      await store.writeConfig(config);
      console.log(JSON.stringify(store.readConfig()));
    `
  );

  assert.deepEqual(persisted, config);
});

test("updateTask and deleteTask reject unknown task ids", () => {
  const workspace = createTempWorkspace();
  const result = runStoreScript(
    workspace,
    `
      const errors = [];
      try {
        await store.updateTask("missing", { status: "closed" });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await store.deleteTask("missing");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      console.log(JSON.stringify(errors));
    `
  );

  assert.deepEqual(result, ["Task missing not found", "Task missing not found"]);
});
