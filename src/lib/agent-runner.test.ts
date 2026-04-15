import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Task } from "./types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const AGENT_RUNNER_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/agent-runner.ts")
).href;
const STORE_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, "src/lib/store.ts")).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "agent-runner-test-"));
}

function writeTemplates(workspace: string) {
  mkdirSync(path.join(workspace, "prompts", "templates"), { recursive: true });
  writeFileSync(
    path.join(workspace, "prompts", "templates", "initial.md"),
    "INITIAL {{TASK_TITLE}} | {{TASK_DESCRIPTION}} | {{TASK_PLAN}} | {{AGENT_NAME}}"
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "review.md"),
    "REVIEW {{PR_URL}} | {{BASE_BRANCH}} | {{MERGE_STATUS}} | {{AGENT_NAME}}"
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "cleanup.md"),
    "CLEANUP {{FINAL_STATUS}} | {{TASK_TITLE}} | {{AGENT_DIRECTORY}}"
  );
}

function writeConfig(workspace: string) {
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  mkdirSync(path.join(workspace, "prompts", "agents"), { recursive: true });
  mkdirSync(path.join(workspace, "worktree"), { recursive: true });

  writeFileSync(path.join(workspace, ".env"), "GLOBAL_ONLY=global\nSHARED=global\n");
  writeFileSync(
    path.join(workspace, "prompts", "agents", ".env.cortex-city-swe"),
    "AGENT_ONLY=agent\nSHARED=agent\n"
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.md"),
    "Agent-specific prompt"
  );
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(
      {
        max_parallel_sessions: 2,
        poll_interval_seconds: 30,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "codex",
        agents: {
          "cortex-city-swe": {
            name: "Cortex City SWE",
            repo_slug: "farshidz/cortex-city",
            repo_path: workspace,
            prompt_file: "prompts/agents/cortex-city-swe.md",
            default_branch: "main",
            description: "Owns the control panel and worker.",
          },
        },
      },
      null,
      2
    )
  );
}

function writeFakeCodex(workspace: string) {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const codexPath = path.join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("fs");

if (process.env.FAKE_AGENT_ARGS_FILE) {
  writeFileSync(
    process.env.FAKE_AGENT_ARGS_FILE,
    JSON.stringify({
      args: process.argv.slice(2),
      env: {
        GLOBAL_ONLY: process.env.GLOBAL_ONLY,
        AGENT_ONLY: process.env.AGENT_ONLY,
        SHARED: process.env.SHARED,
      },
    })
  );
}

if (process.env.FAKE_AGENT_STDERR) {
  process.stderr.write(process.env.FAKE_AGENT_STDERR);
}

if (process.env.FAKE_AGENT_STDOUT) {
  process.stdout.write(process.env.FAKE_AGENT_STDOUT);
}
`
  );
  chmodSync(codexPath, 0o755);
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Cover orchestration edges",
    description: "Exercise agent-runner prompt selection",
    plan: "Add focused tests",
    status: "in_progress",
    agent: "cortex-city-swe",
    agent_runner: "codex",
    permission_mode: "bypassPermissions",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    worktree_path: path.join(REPO_ROOT, "tmp"),
    ...overrides,
  };
}

function runAgentRunnerScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { spawnAgentSession, __testUtils } from ${JSON.stringify(AGENT_RUNNER_MODULE_URL)};`,
        `import { createTask, readTasks } from ${JSON.stringify(STORE_MODULE_URL)};`,
        "(async () => {",
        `  process.env.PATH = ${JSON.stringify(
          path.join(workspace, "bin")
        )} + ":" + process.env.PATH;`,
        body,
        "})().catch((error) => {",
        "  console.error(error);",
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
    }
  );

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function setupWorkspace(): string {
  const workspace = createTempWorkspace();
  writeTemplates(workspace);
  writeConfig(workspace);
  writeFakeCodex(workspace);
  mkdirSync(path.join(workspace, "worktree"), { recursive: true });
  return workspace;
}

test("spawnAgentSession prioritizes manual instructions on resumed runs and merges env files", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "manual-args.json");
  const logDir = path.join(workspace, "logs");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    status: "completed",
    summary: "Manual instruction applied",
    pr_url: "",
    branch_name: "agent/manual",
    files_changed: [],
    assumptions: [],
    blockers: [],
    next_steps: [],
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          session_id: "thread-123",
          pending_manual_instruction: "  Apply the reviewer feedback  ",
          pr_url: "https://github.com/farshidz/cortex-city/pull/4",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(report),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 4, cached_input_tokens: 3, output_tokens: 2 },
          }),
        ].join("\n")
      )};

      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "review", () => resolve(undefined))
          .catch(reject);
      });

      const logs = require("node:fs").readdirSync(${JSON.stringify(logDir)});
      const logPath = require("node:path").join(${JSON.stringify(logDir)}, logs[0]);
      console.log(
        JSON.stringify({
          tasks: readTasks(),
          args: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8")),
          log: require("node:fs").readFileSync(logPath, "utf-8"),
        })
      );
    `
  );

  assert.deepEqual(result.args.args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(result.args.args.includes("thread-123"));
  assert.equal(result.args.args.at(-1), "Apply the reviewer feedback");
  assert.ok(
    result.args.args.includes("--dangerously-bypass-approvals-and-sandbox")
  );
  assert.deepEqual(result.args.env, {
    GLOBAL_ONLY: "global",
    AGENT_ONLY: "agent",
    SHARED: "agent",
  });
  assert.match(result.log, /"mode":"manual"/);
  assert.match(result.log, /"content":"Apply the reviewer feedback"/);

  const [updatedTask] = result.tasks;
  assert.equal(updatedTask.session_id, "thread-123");
  assert.equal(updatedTask.last_run_result, "success");
  assert.equal(updatedTask.run_count, 1);
  assert.equal(updatedTask.total_input_tokens, 7);
  assert.equal(updatedTask.total_output_tokens, 2);
});

test("spawnAgentSession uses the review prompt and creates follow-up tasks from tool calls", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "review-args.json");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    status: "needs_review",
    summary: "Opened the PR and delegated docs follow-up",
    pr_url: "https://github.com/farshidz/cortex-city/pull/9",
    branch_name: "agent/review-pass",
    files_changed: ["src/lib/agent-runner.ts"],
    assumptions: [],
    blockers: [],
    next_steps: [],
    tool_calls: {
      create_task: [
        {
          title: "  Document the follow-up  ",
          description: "  Add release notes for the worker change  ",
          agent: "cortex-city-swe",
          plan: "  Update the changelog  ",
        },
        {
          title: "Missing description",
          description: "   ",
          agent: "cortex-city-swe",
        },
      ],
    },
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          status: "in_review",
          pr_url: "https://github.com/farshidz/cortex-city/pull/9",
          pr_status: "needs_approval",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-review" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(report),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 11, cached_input_tokens: 1, output_tokens: 5 },
          }),
        ].join("\n")
      )};

      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "review", () => resolve(undefined))
          .catch(reject);
      });

      console.log(
        JSON.stringify({
          tasks: readTasks(),
          args: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8")),
        })
      );
    `
  );

  assert.equal(result.args.args[0], "exec");
  assert.equal(result.args.args[1], "--json");
  assert.match(
    result.args.args.at(-1),
    /^REVIEW https:\/\/github.com\/farshidz\/cortex-city\/pull\/9 \| main \| Waiting on approvals, but code can merge cleanly\. \| Cortex City SWE$/
  );

  assert.equal(result.tasks.length, 2);
  const [parentTask, followupTask] = result.tasks;
  assert.equal(parentTask.status, "in_review");
  assert.equal(parentTask.pr_url, "https://github.com/farshidz/cortex-city/pull/9");
  assert.equal(parentTask.branch_name, "agent/review-pass");
  assert.equal(parentTask.session_id, "thread-review");
  assert.equal(parentTask.last_agent_report.summary, "Opened the PR and delegated docs follow-up");
  assert.equal(parentTask.last_agent_report.tool_calls.create_task.length, 2);
  assert.equal(parentTask.run_count, 1);
  assert.equal(parentTask.total_input_tokens, 12);
  assert.equal(parentTask.total_output_tokens, 5);

  assert.equal(followupTask.title, "Document the follow-up");
  assert.equal(followupTask.description, "Add release notes for the worker change");
  assert.equal(followupTask.plan, "Update the changelog");
  assert.equal(followupTask.parent_task_id, "task-1");
  assert.equal(followupTask.agent_runner, "codex");
  assert.equal(followupTask.permission_mode, "bypassPermissions");
});

test("cleanup runs use the cleanup prompt even when a session already exists", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "cleanup-args.json");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    status: "completed",
    summary: "Cleaned up the branch",
    pr_url: "",
    branch_name: "agent/cleanup",
    files_changed: [],
    assumptions: [],
    blockers: [],
    next_steps: [],
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          status: "closed",
          session_id: "thread-cleanup",
          branch_name: "agent/cleanup",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-cleanup" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(report),
            },
          }),
        ].join("\n")
      )};

      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "cleanup", () => resolve(undefined))
          .catch(reject);
      });

      console.log(
        JSON.stringify({
          tasks: readTasks(),
          args: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8")),
        })
      );
    `
  );

  assert.deepEqual(result.args.args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(result.args.args.includes("thread-cleanup"));
  assert.match(result.args.args.at(-1), /^CLEANUP closed \| Cover orchestration edges \|/);
  assert.equal(result.tasks[0].last_run_result, "success");
});

test("plain-text PR output still moves the task into review and keeps the existing session id", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "fallback-args.json");
  const worktreePath = path.join(workspace, "worktree");

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          session_id: "existing-thread",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Created PR https://github.com/farshidz/cortex-city/pull/11",
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 },
          }),
        ].join("\n")
      )};

      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => resolve(undefined))
          .catch(reject);
      });

      console.log(
        JSON.stringify({
          tasks: readTasks(),
          args: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8")),
        })
      );
    `
  );

  assert.equal(result.args.args[1], "resume");
  assert.equal(result.tasks[0].session_id, "existing-thread");
  assert.equal(result.tasks[0].pr_url, "https://github.com/farshidz/cortex-city/pull/11");
  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].run_count, 1);
});

test("createFollowupTasks trims task data, inherits runtime settings, and skips invalid requests", () => {
  const workspace = setupWorkspace();

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          permission_mode: "acceptEdits",
          worktree_path: path.join(workspace, "worktree"),
        })
      )};
      await createTask(task);
      await __testUtils.createFollowupTasks(task, [
        {
          title: "  Document the follow-up  ",
          description: "  Add release notes for the worker change  ",
          agent: "cortex-city-swe",
          plan: "  Update the changelog  ",
        },
        {
          title: "Missing description",
          description: "   ",
          agent: "cortex-city-swe",
        },
      ]);
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks.length, 2);
  const followupTask = result.tasks[1];
  assert.equal(followupTask.title, "Document the follow-up");
  assert.equal(followupTask.description, "Add release notes for the worker change");
  assert.equal(followupTask.plan, "Update the changelog");
  assert.equal(followupTask.parent_task_id, "task-1");
  assert.equal(followupTask.agent_runner, "codex");
  assert.equal(followupTask.permission_mode, "acceptEdits");
});
