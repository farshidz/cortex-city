import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
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
    "INITIAL {{TASK_TITLE}} | {{TASK_DESCRIPTION}} | {{TASK_PLAN}} | {{BASE_BRANCH}} | {{AGENT_NAME}}"
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
    path.join(workspace, "prompts", "agents", "marqo-documentation-agent.md"),
    "Docs prompt"
  );
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(
      {
        max_parallel_sessions: 2,
        poll_interval_seconds: 30,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "codex",
        default_codex_model: "gpt-5.4",
        default_codex_effort: "xhigh",
        default_claude_model: "claude-sonnet-4-6",
        default_claude_effort: "max",
        agents: {
          "cortex-city-swe": {
            name: "Cortex City SWE",
            repo_slug: "farshidz/cortex-city",
            repo_path: workspace,
            prompt_file: "prompts/agents/cortex-city-swe.md",
            default_branch: "main",
            description: "Owns the control panel and worker.",
          },
          "marqo-documentation-agent": {
            name: "Marqo Documentation Agent",
            repo_slug: "marqo-ai/marqodocs",
            repo_path: workspace,
            prompt_file: "prompts/agents/marqo-documentation-agent.md",
            default_branch: "docusaurus-main",
          },
        },
      },
      null,
      2
    )
  );
}

function writeFakeAgent(workspace: string, binaryName: "codex" | "claude") {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, binaryName);
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("fs");

if (process.env.FAKE_AGENT_ARGS_FILE) {
  writeFileSync(
    process.env.FAKE_AGENT_ARGS_FILE,
    JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
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
  chmodSync(binaryPath, 0o755);
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
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning until we find the final JSON payload.
    }
  }
  throw new SyntaxError(`No JSON payload found in output:\n${output}`);
}

function setupWorkspace(): string {
  const workspace = createTempWorkspace();
  writeTemplates(workspace);
  writeConfig(workspace);
  writeFakeAgent(workspace, "codex");
  writeFakeAgent(workspace, "claude");
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
      const transcriptFile = logs.find((name) => name.endsWith(".log"));
      const machineFile = logs.find((name) => name.endsWith(".jsonl"));
      console.log(
        JSON.stringify({
          tasks: readTasks(),
          args: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(argsFile)}, "utf-8")),
          transcript: require("node:fs").readFileSync(
            require("node:path").join(${JSON.stringify(logDir)}, transcriptFile),
            "utf-8"
          ),
          machine: require("node:fs").readFileSync(
            require("node:path").join(${JSON.stringify(logDir)}, machineFile),
            "utf-8"
          ),
        })
      );
    `
  );

  assert.equal(result.args.args[0], "exec");
  assert.equal(result.args.args[1], "--json");
  assert.ok(result.args.args.includes("--output-schema"));
  assert.ok(result.args.args.includes("resume"));
  assert.ok(result.args.args.includes("thread-123"));
  assert.equal(result.args.args.at(-1), "Apply the reviewer feedback");
  assert.ok(
    result.args.args.includes("--dangerously-bypass-approvals-and-sandbox")
  );
  assert.ok(result.args.args.includes("--model"));
  assert.ok(result.args.args.includes("gpt-5.4"));
  assert.ok(result.args.args.includes("-c"));
  assert.ok(result.args.args.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(result.args.env, {
    GLOBAL_ONLY: "global",
    AGENT_ONLY: "agent",
    SHARED: "agent",
  });
  assert.match(result.machine, /"mode":"manual"/);
  assert.match(result.machine, /"content":"Apply the reviewer feedback"/);
  assert.match(result.transcript, /USER \(Manual prompt\)/);
  assert.match(result.transcript, /Apply the reviewer feedback/);
  assert.match(result.transcript, /Status: completed/);
  assert.match(result.transcript, /Summary: Manual instruction applied/);

  const [updatedTask] = result.tasks;
  assert.equal(updatedTask.session_id, "thread-123");
  assert.equal(updatedTask.last_run_result, "success");
  assert.equal(updatedTask.run_count, 1);
  assert.equal(updatedTask.total_input_tokens, 4);
  assert.equal(updatedTask.total_cached_input_tokens, 3);
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
          model: "gpt-5.5-codex",
          effort: "medium",
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
  assert.ok(result.args.args.includes("--output-schema"));
  assert.ok(result.args.args.includes("--model"));
  assert.ok(result.args.args.includes("gpt-5.5-codex"));
  assert.ok(result.args.args.includes('model_reasoning_effort="medium"'));
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
  assert.equal(parentTask.total_input_tokens, 11);
  assert.equal(parentTask.total_cached_input_tokens, 1);
  assert.equal(parentTask.total_output_tokens, 5);

  assert.equal(followupTask.title, "Document the follow-up");
  assert.equal(followupTask.description, "Add release notes for the worker change");
  assert.equal(followupTask.plan, "Update the changelog");
  assert.equal(followupTask.parent_task_id, "task-1");
  assert.equal(followupTask.agent_runner, "codex");
  assert.equal(followupTask.permission_mode, "bypassPermissions");
  assert.equal(followupTask.model, "gpt-5.5-codex");
  assert.equal(followupTask.effort, "medium");
});

test("spawnAgentSession uses the configured default branch in the initial prompt", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "initial-args.json");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    status: "completed",
    summary: "Opened docs PR",
    pr_url: "https://github.com/marqo-ai/marqodocs/pull/12",
    branch_name: "agent/docs-change",
    files_changed: ["docusaurus/docs/example.md"],
    assumptions: [],
    blockers: [],
    next_steps: [],
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          status: "open",
          agent: "marqo-documentation-agent",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-docs" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(report),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 },
          }),
        ].join("\\n")
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

  assert.match(
    result.args.args.at(-1),
    /^INITIAL Cover orchestration edges \| Exercise agent-runner prompt selection \| Add focused tests \| docusaurus-main \| Marqo Documentation Agent$/
  );
  assert.equal(result.tasks[0].last_run_result, "success");
});

test("cleanup runs use the cleanup prompt without resuming a prior session", () => {
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

  assert.equal(result.args.args[0], "exec");
  assert.equal(result.args.args[1], "--json");
  assert.ok(result.args.args.includes("--output-schema"));
  assert.ok(!result.args.args.includes("resume"));
  assert.ok(!result.args.args.includes("thread-cleanup"));
  assert.match(result.args.args.at(-1), /^CLEANUP closed \| Cover orchestration edges \|/);
  assert.equal(result.tasks[0].last_run_result, "success");
  assert.equal(result.tasks[0].status, "closed");
});

test("resume-after-kill runs use the continue prompt for Codex", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "continue-args.json");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    status: "completed",
    summary: "Resumed the interrupted run",
    pr_url: "",
    branch_name: "agent/continue",
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
          status: "in_progress",
          session_id: "thread-resume",
          resume_requested: true,
          permission_mode: "default",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-resume" }),
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

  assert.equal(result.args.args[0], "exec");
  assert.ok(result.args.args.includes("resume"));
  assert.ok(result.args.args.includes("thread-resume"));
  assert.equal(result.args.args.at(-1), "continue");
  assert.ok(result.args.args.includes("--full-auto"));
  assert.ok(!result.args.args.includes("--dangerously-bypass-approvals-and-sandbox"));
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

  assert.equal(result.args.args[0], "exec");
  assert.equal(result.args.args[1], "--json");
  assert.ok(result.args.args.includes("--output-schema"));
  assert.ok(result.args.args.includes("resume"));
  assert.equal(result.tasks[0].session_id, "existing-thread");
  assert.equal(result.tasks[0].pr_url, "https://github.com/farshidz/cortex-city/pull/11");
  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].run_count, 1);
});

test("spawnAgentSession maps Claude initial-run permissions and uses the task worktree as cwd", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "claude-initial-args.json");
  const worktreePath = path.join(workspace, "claude-worktree");
  mkdirSync(worktreePath, { recursive: true });
  const report = {
    type: "result",
    subtype: "print",
    is_error: false,
    duration_ms: 25,
    result: JSON.stringify({
      status: "completed",
      summary: "Claude initial run",
      pr_url: "",
      branch_name: "agent/claude-initial",
      files_changed: [],
      assumptions: [],
      blockers: [],
      next_steps: [],
    }),
    session_id: "claude-initial-session",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    structured_output: {
      status: "completed",
      summary: "Claude initial run",
      pr_url: "",
      branch_name: "agent/claude-initial",
      files_changed: [],
      assumptions: [],
      blockers: [],
      next_steps: [],
    },
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    },
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          status: "open",
          agent_runner: "claude",
          permission_mode: "yolo",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(JSON.stringify(report))};

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

  assert.equal(result.args.args[0], "-p");
  assert.ok(result.args.args.includes("--output-format"));
  assert.ok(result.args.args.includes("--json-schema"));
  assert.ok(!result.args.args.includes("--resume"));
  assert.ok(result.args.args.includes("--permission-mode"));
  assert.ok(result.args.args.includes("bypassPermissions"));
  assert.equal(result.args.cwd, realpathSync(worktreePath));
  assert.equal(result.tasks[0].session_id, "claude-initial-session");
});

test("createFollowupTasks trims task data, inherits runtime settings, and skips invalid requests", () => {
  const workspace = setupWorkspace();

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          permission_mode: "acceptEdits",
          model: "gpt-5.4-mini",
          effort: "low",
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
  assert.equal(followupTask.model, "gpt-5.4-mini");
  assert.equal(followupTask.effort, "low");
});

test("appendToBoundedTextBuffer keeps only the latest bytes", () => {
  const workspace = setupWorkspace();

  const result = runAgentRunnerScript(
    workspace,
    `
      const buffer = { value: "", truncated: false };
      __testUtils.appendToBoundedTextBuffer(buffer, "abcd", 4);
      __testUtils.appendToBoundedTextBuffer(buffer, "ef", 4);
      console.log(JSON.stringify(buffer));
    `
  );

  assert.deepEqual(result, {
    value: "cdef",
    truncated: true,
  });
});

test("spawnAgentSession passes Claude model and effort flags", () => {
  const workspace = setupWorkspace();
  const argsFile = path.join(workspace, "claude-args.json");
  const worktreePath = path.join(workspace, "worktree");
  const report = {
    type: "result",
    subtype: "print",
    is_error: false,
    duration_ms: 123,
    result: JSON.stringify({
      status: "completed",
      summary: "Claude model config applied",
      pr_url: "",
      branch_name: "agent/claude-model",
      files_changed: [],
      assumptions: [],
      blockers: [],
      next_steps: [],
    }),
    session_id: "claude-session",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    structured_output: {
      status: "completed",
      summary: "Claude model config applied",
      pr_url: "",
      branch_name: "agent/claude-model",
      files_changed: [],
      assumptions: [],
      blockers: [],
      next_steps: [],
    },
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 1,
    },
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          agent_runner: "claude",
          permission_mode: "acceptEdits",
          model: "claude-opus-4-1",
          effort: "high",
          session_id: "claude-existing-session",
          worktree_path: worktreePath,
        })
      )};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(JSON.stringify(report))};

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

  assert.equal(result.args.args[0], "-p");
  assert.ok(result.args.args.includes("--model"));
  assert.ok(result.args.args.includes("claude-opus-4-1"));
  assert.ok(result.args.args.includes("--effort"));
  assert.ok(result.args.args.includes("high"));
  assert.ok(result.args.args.includes("--permission-mode"));
  assert.ok(result.args.args.includes("acceptEdits"));
  assert.ok(result.args.args.includes("--json-schema"));
  assert.ok(result.args.args.includes("--resume"));
  assert.ok(result.args.args.includes("claude-existing-session"));
  assert.equal(result.tasks[0].session_id, "claude-session");
});
