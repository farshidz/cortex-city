import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { OrchestratorConfig, Task } from "./types";
import {
  createTempWorkspace,
  initGitTestRepo,
  moduleUrl,
  prependBinToPath,
  runTsxScript,
  writeAgentPrompts,
  writeFakeAgentBinary,
  writeFakeGhBinary,
  writeJson,
  writePromptTemplates,
  writeTestConfig,
} from "./test-harness";

const AGENT_RUNNER_MODULE_URL = moduleUrl("src/lib/agent-runner.ts");
const STORE_MODULE_URL = moduleUrl("src/lib/store.ts");

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Cover runtime handling",
    description: "Exercise worker and runner edge cases",
    status: "open",
    agent: "cortex-city-swe",
    agent_runner: "codex",
    permission_mode: "bypassPermissions",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

function setupWorkspace(options: {
  configOverrides?: Partial<OrchestratorConfig>;
  repoPath?: string;
} = {}) {
  const workspace = createTempWorkspace("agent-runner-runtime-");
  writePromptTemplates(workspace);
  writeAgentPrompts(workspace);
  writeFakeAgentBinary(workspace, "codex");
  writeFakeAgentBinary(workspace, "claude");
  writeFakeGhBinary(workspace);
  const repoPath = options.repoPath ?? workspace;
  writeTestConfig(workspace, options.configOverrides, {
    "cortex-city-swe": {
      repo_path: repoPath,
      default_branch: "main",
    },
  });
  return { workspace, repoPath };
}

function runAgentRunnerScript(
  workspace: string,
  body: string,
  env: NodeJS.ProcessEnv = prependBinToPath(workspace)
) {
  return runTsxScript(
    workspace,
    [
      `import { spawnAgentSession, removeWorktree, __testUtils } from ${JSON.stringify(AGENT_RUNNER_MODULE_URL)};`,
      `import { createTask, readTasks } from ${JSON.stringify(STORE_MODULE_URL)};`,
    ],
    body,
    env
  );
}

test("handleRunComplete marks malformed runtime output as error", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ status: "in_progress", current_run_pid: 1234 }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        "not-json",
        "",
        42,
        [],
        "claude",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "error");
  assert.equal(result.tasks[0].current_run_pid, undefined);
});

test("handleRunComplete treats non-zero exits as errors without transitioning review state", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ status: "open" }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        1,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "runtime returned a report",
            session_id: "claude-session",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "completed",
              summary: "Run produced a PR before failing",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/17",
              branch_name: "agent/non-zero",
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
          })
        )},
        "",
        123,
        [],
        "claude",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "error");
  assert.equal(result.tasks[0].status, "open");
  assert.equal(result.tasks[0].run_count, 1);
  assert.equal(result.tasks[0].session_id, "claude-session");
});

test("handleRunComplete records budget exceeded results without follow-up transitions", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ status: "open" }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "budget exhausted",
            session_id: "claude-session",
            terminal_reason: "budget_exceeded",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "needs_review",
              summary: "Partial output",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/18",
              branch_name: "agent/budget",
              files_changed: [],
              assumptions: [],
              blockers: [],
              next_steps: [],
            },
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              cache_read_input_tokens: 0,
            },
          })
        )},
        "",
        25,
        [],
        "claude",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "budget_exceeded");
  assert.equal(result.tasks[0].status, "open");
  assert.equal(result.tasks[0].run_count, 1);
});

test("handleRunComplete creates Claude follow-up tasks and updates review metadata", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#19": {
        state: "open",
        merged: false,
        headRefOid: "abc123",
        reviews: [{ id: 50, state: "APPROVED" }],
        comments: [{ id: 11, pull_request_review_id: null }],
        issueComments: [{ id: 12 }],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        agent_runner: "claude",
        status: "open",
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "done",
            session_id: "claude-session",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "needs_review",
              summary: "Opened PR and queued docs follow-up",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/19",
              branch_name: "agent/claude-review",
              files_changed: ["src/orchestrator-worker.ts"],
              assumptions: [],
              blockers: [],
              next_steps: [],
              tool_calls: {
                create_task: [
                  {
                    title: "  Document worker recovery  ",
                    description: "  Write release notes for timeout handling  ",
                    agent: "cortex-city-swe",
                    plan: "  Update the changelog  ",
                  },
                  {
                    title: "Missing description",
                    description: "  ",
                    agent: "cortex-city-swe",
                  },
                ],
              },
            },
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              cache_read_input_tokens: 2,
            },
          })
        )},
        "",
        77,
        [11, 12],
        "claude",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].session_id, "claude-session");
  assert.equal(result.tasks[0].pr_url, "https://github.com/farshidz/marqo-cortex-city/pull/19");
  assert.match(result.tasks[0].last_review_gh_state, /^[a-f0-9]{16}$/);
  assert.equal(result.tasks[0].run_count, 1);
  assert.equal(result.tasks[1].title, "Document worker recovery");
  assert.equal(result.tasks[1].agent_runner, "claude");
});

test("handleRunComplete supports plain-text Claude PR fallback", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        agent_runner: "claude",
        status: "open",
        session_id: "existing-session",
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "Created PR https://github.com/farshidz/marqo-cortex-city/pull/20",
            session_id: "",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              cache_read_input_tokens: 0,
            },
          })
        )},
        "",
        33,
        [],
        "claude",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].pr_url, "https://github.com/farshidz/marqo-cortex-city/pull/20");
  assert.equal(result.tasks[0].session_id, "existing-session");
});

test("handleRunComplete preserves Codex session ids when thread.started is missing", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        session_id: "thread-existing",
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          [
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  status: "completed",
                  summary: "Opened PR",
                  pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/21",
                  branch_name: "agent/codex-existing",
                  files_changed: [],
                  assumptions: [],
                  blockers: [],
                  next_steps: [],
                }),
              },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 },
            }),
          ].join("\\n")
        )},
        "",
        65,
        [],
        "codex",
        "initial"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].session_id, "thread-existing");
  assert.equal(result.tasks[0].status, "in_review");
});

test("manual instruction runs leave the existing review hash unchanged", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-manual-state.json");
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#22": {
        state: "open",
        merged: false,
        headRefOid: "def456",
        reviews: [{ id: 70, state: "COMMENTED" }],
        comments: [{ id: 15, pull_request_review_id: null }],
        issueComments: [],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_review",
        pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
        last_review_gh_state: "existing-hash",
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "done",
            session_id: "claude-session",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "needs_review",
              summary: "Handled manual instruction",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
              branch_name: "agent/manual-hash",
              files_changed: [],
              assumptions: [],
              blockers: [],
              next_steps: [],
            },
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
            },
          })
        )},
        "",
        10,
        [15],
        "claude",
        "manual_instruction"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.tasks[0].last_review_gh_state, "existing-hash");
});

test("new GitHub comments during a run skip review hash updates", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-comments-state.json");
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#23": {
        state: "open",
        merged: false,
        headRefOid: "xyz789",
        reviews: [{ id: 90, state: "COMMENTED" }],
        comments: [
          { id: 15, pull_request_review_id: null },
          { id: 16, pull_request_review_id: null },
        ],
        issueComments: [],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_review",
        pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/23",
        last_review_gh_state: "existing-hash",
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        ${JSON.stringify(
          JSON.stringify({
            type: "result",
            subtype: "print",
            is_error: false,
            duration_ms: 10,
            result: "done",
            session_id: "claude-session",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "needs_review",
              summary: "Handled review comments",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/23",
              branch_name: "agent/comments",
              files_changed: [],
              assumptions: [],
              blockers: [],
              next_steps: [],
            },
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
            },
          })
        )},
        "",
        10,
        [15],
        "claude",
        "review"
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.tasks[0].last_review_gh_state, "existing-hash");
});

test("spawnAgentSession marks timed out runs resumable", () => {
  const { workspace } = setupWorkspace({
    configOverrides: {
      task_run_timeout_ms: 50,
    },
  });
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const worktreePath = path.join(workspace, "worktree");
  mkdirSync(worktreePath, { recursive: true });
  writeJson(scenarioFile, {
    codex: {
      sleepMs: 200,
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        worktree_path: worktreePath,
      }))};
      await createTask(task);
      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => resolve(undefined)).catch(reject);
      });
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.tasks[0].last_run_result, "timeout");
  assert.equal(result.tasks[0].resume_requested, true);
  assert.equal(result.tasks[0].current_run_pid, undefined);
});

test("spawnAgentSession handles child spawn errors", () => {
  const { workspace } = setupWorkspace();
  const worktreePath = path.join(workspace, "worktree");
  mkdirSync(worktreePath, { recursive: true });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        worktree_path: worktreePath,
      }))};
      await createTask(task);
      const env = { ...process.env };
      process.env.PATH = ${JSON.stringify(workspace)}; // no runtimes available
      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => resolve(undefined)).catch(reject);
      });
      process.env.PATH = env.PATH;
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "error");
  assert.equal(result.tasks[0].current_run_pid, undefined);
});

test("ensureWorktree reuses an existing worktree path", () => {
  const { workspace } = setupWorkspace();
  const worktreePath = path.join(workspace, "existing-worktree");
  mkdirSync(worktreePath, { recursive: true });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ worktree_path: worktreePath }))};
      await createTask(task);
      const ensured = await __testUtils.ensureWorktree(task, ${JSON.stringify(workspace)}, "main");
      console.log(JSON.stringify({ ensured, tasks: readTasks() }));
    `
  );

  assert.equal(result.ensured, worktreePath);
  assert.equal(result.tasks[0].worktree_path, worktreePath);
});

test("ensureWorktree creates a missing branch from origin/main", () => {
  const workspace = createTempWorkspace("agent-runner-worktree-");
  const { repoPath } = initGitTestRepo(workspace);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Create missing worktree branch",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ worktreePath, branch, tasks: readTasks() }));
    `
  );

  assert.match(result.branch, /^agent\/create-missing-work/);
  assert.equal(result.tasks[0].branch_name, result.branch);
  assert.equal(result.tasks[0].worktree_path, result.worktreePath);
});

test("ensureWorktree reuses an existing local branch", () => {
  const workspace = createTempWorkspace("agent-runner-branch-");
  const { repoPath } = initGitTestRepo(workspace);
  execFileSync("git", ["-C", repoPath, "branch", "agent/existing-branch", "main"]);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Existing branch",
        branch_name: "agent/existing-branch",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ branch, tasks: readTasks() }));
    `
  );

  assert.equal(result.branch, "agent/existing-branch");
  assert.equal(result.tasks[0].branch_name, "agent/existing-branch");
});

test("ensureWorktree creates a fallback branch when the requested branch is already checked out elsewhere", () => {
  const workspace = createTempWorkspace("agent-runner-collision-");
  const { repoPath } = initGitTestRepo(workspace);
  const occupiedPath = path.join(workspace, "occupied");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "agent/conflict", occupiedPath, "origin/main"]);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Conflicting branch",
        branch_name: "agent/conflict",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ branch, tasks: readTasks() }));
    `
  );

  assert.equal(result.branch, "agent/conflict-2");
  assert.equal(result.tasks[0].branch_name, "agent/conflict-2");
});

test("ensureWorktree tolerates fetch failures when a reusable local branch exists", () => {
  const workspace = createTempWorkspace("agent-runner-fetch-");
  const repoPath = path.join(workspace, "repo");
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Cortex Tests"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "cortex@example.com"], { cwd: repoPath });
  writeFileSync(path.join(repoPath, "README.md"), "# test repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });
  execFileSync("git", ["branch", "agent/fetch-ok"], { cwd: repoPath });
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        title: "Fetch failure branch",
        branch_name: "agent/fetch-ok",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      console.log(JSON.stringify({ worktreePath, tasks: readTasks() }));
    `
  );

  assert.match(result.tasks[0].worktree_path, /fetch-failure-branch$/);
});

test("ensureWorktree surfaces git worktree add failures when no branch can be created", () => {
  const workspace = createTempWorkspace("agent-runner-failure-");
  const repoPath = path.join(workspace, "repo");
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Cortex Tests"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "cortex@example.com"], { cwd: repoPath });
  writeFileSync(path.join(repoPath, "README.md"), "# test repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        title: "Worktree failure",
      }))};
      await createTask(task);
      let errorMessage = "";
      try {
        await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({ errorMessage, tasks: readTasks() }));
    `
  );

  assert.match(result.errorMessage, /origin\/main|worktree/i);
});

test("removeWorktree swallows git failures", () => {
  const workspace = createTempWorkspace("agent-runner-remove-");
  const { repoPath } = initGitTestRepo(workspace);
  const setup = setupWorkspace({ repoPath });
  const missingWorktreePath = path.join(setup.workspace, "missing-worktree");

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        worktree_path: missingWorktreePath,
      }))};
      removeWorktree(task);
      console.log(JSON.stringify({ ok: true }));
    `
  );

  assert.equal(result.ok, true);
});
