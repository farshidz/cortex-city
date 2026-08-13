import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
      `import { createTask, readTasks, updateTask } from ${JSON.stringify(STORE_MODULE_URL)};`,
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

test(
  "handleRunComplete treats non-zero exits as errors without transitioning review state even when parsed payloads include review fields",
  () => {
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
  }
);

test(
  "handleRunComplete records budget exceeded results without follow-up transitions even when parsed payloads include review fields",
  () => {
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
  }
);

test("handleRunComplete records stacked PRs, mirrors the frontier, and captures per-entry hashes", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      // PR 21 gained a comment (id 30) during the run: its hash must be
      // skipped so the next poll wakes the task.
      "farshidz/marqo-cortex-city#21": {
        state: "open",
        merged: false,
        headRefOid: "head-21",
        reviews: [],
        comments: [],
        issueComments: [{ id: 30 }],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
      "farshidz/marqo-cortex-city#22": {
        state: "open",
        merged: false,
        headRefOid: "head-22",
        reviews: [],
        comments: [],
        issueComments: [{ id: 12 }],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ agent_runner: "claude", status: "open" }))};
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
              status: "completed",
              summary: "Opened a two-PR stack",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/21",
              branch_name: "agent/stack",
              stacked_prs: [
                {
                  position: 1,
                  pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/21",
                  branch_name: "agent/stack",
                  base_branch: "main",
                  scope: "Slice one",
                },
                {
                  position: 2,
                  pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
                  branch_name: "agent/stack-2",
                  base_branch: "agent/stack",
                  scope: "Slice two",
                },
              ],
              files_changed: [],
              assumptions: [],
              blockers: [],
              next_steps: [],
              tool_calls: null,
            },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_input_tokens: 1,
            },
          })
        )},
        "",
        42,
        { "https://github.com/farshidz/marqo-cortex-city/pull/22": [12] },
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

  const task = result.tasks[0];
  assert.equal(task.status, "in_review");
  assert.equal(task.pr_url, "https://github.com/farshidz/marqo-cortex-city/pull/21");
  assert.equal(task.branch_name, "agent/stack");
  assert.equal(task.stacked_prs.length, 2);
  assert.equal(task.stacked_prs[0].state, "open");
  assert.equal(task.stacked_prs[0].scope, "Slice one");
  // PR 21 saw a mid-run comment, so only PR 22 gets a captured hash.
  assert.equal(task.stacked_prs[0].last_review_gh_state, undefined);
  assert.match(task.stacked_prs[1].last_review_gh_state, /^[a-f0-9]{16}$/);
  // Stacked tasks do not use the task-level hash.
  assert.equal(task.last_review_gh_state, undefined);
});

test("handleRunComplete keeps worker-owned stack state and re-mirrors after restack", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-state.json");
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#22": {
        state: "open",
        merged: false,
        headRefOid: "head-22",
        reviews: [],
        comments: [],
        issueComments: [],
        checks: [{ name: "test", state: "SUCCESS" }],
      },
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          agent_runner: "claude",
          status: "in_review",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
          branch_name: "agent/stack-2",
          stacked_prs: [
            {
              position: 1,
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/21",
              branch_name: "agent/stack",
              base_branch: "main",
              scope: "Slice one",
              state: "merged",
            },
            {
              position: 2,
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
              branch_name: "agent/stack-2",
              base_branch: "agent/stack",
              scope: "Slice two",
              state: "open",
            },
          ],
        })
      )};
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
            result: "restacked",
            session_id: "claude-session",
            terminal_reason: "completed",
            total_cost_usd: 0,
            num_turns: 1,
            structured_output: {
              status: "completed",
              summary: "Restacked PR 22 onto main",
              pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
              branch_name: "agent/stack-2",
              stacked_prs: [
                {
                  position: 1,
                  pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/21",
                  branch_name: "agent/stack",
                  base_branch: "main",
                  scope: "Slice one",
                },
                {
                  position: 2,
                  pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/22",
                  branch_name: "agent/stack-2",
                  base_branch: "main",
                  scope: "",
                },
              ],
              files_changed: [],
              assumptions: [],
              blockers: [],
              next_steps: [],
              tool_calls: null,
            },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_input_tokens: 1,
            },
          })
        )},
        "",
        42,
        {},
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

  const task = result.tasks[0];
  // The merged entry keeps its worker-owned state even though the report
  // still lists it, and the mirror follows the open frontier entry.
  assert.equal(task.stacked_prs[0].state, "merged");
  assert.equal(task.stacked_prs[1].state, "open");
  assert.equal(task.stacked_prs[1].base_branch, "main");
  // A blank reported scope falls back to the tracked one.
  assert.equal(task.stacked_prs[1].scope, "Slice two");
  assert.equal(task.pr_url, "https://github.com/farshidz/marqo-cortex-city/pull/22");
  assert.match(task.stacked_prs[1].last_review_gh_state, /^[a-f0-9]{16}$/);
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
          { id: 15, pull_request_review_id: 90 },
          { id: 16, pull_request_review_id: 90 },
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

test("initial-mode manual instructions expose a growing PR stack before Codex exits", () => {
  const { workspace } = setupWorkspace();
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const ghStateFile = path.join(workspace, "gh-live-pr-state.json");
  const firstPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/31";
  const secondPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/32";
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#31": {
        url: firstPrUrl,
        headRefName: "agent/live-stack",
        baseRefName: "main",
        title: "Add live PR discovery",
      },
      "farshidz/marqo-cortex-city#32": {
        url: secondPrUrl,
        headRefName: "agent/live-stack-2",
        baseRefName: "agent/live-stack",
        title: "Show live stacks in the task UI",
      },
    },
  });
  writeJson(scenarioFile, {
    codex: {
      stdoutChunks: [
        {
          text: `${JSON.stringify({
            type: "thread.started",
            thread_id: "thread-live-stack",
          })}\n${JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "/bin/bash -lc 'gh pr create --base main'",
              aggregated_output: `${firstPrUrl}\n`,
              status: "completed",
            },
          })}\n`,
        },
        {
          delayMs: 100,
          text: `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "/bin/bash -lc 'gh pr create --base agent/live-stack'",
              aggregated_output: `${secondPrUrl}\n`,
              status: "completed",
            },
          })}\n`,
        },
      ],
      sleepMs: 2000,
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        pending_manual_instruction: "Open the stacked PRs now",
        worktree_path: workspace,
      }))};
      await createTask(task);
      let completed = false;
      const completion = new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => {
          completed = true;
          resolve(undefined);
        }).catch(reject);
      });

      let firstPrTask;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const candidate = readTasks()[0];
        if (candidate.pr_url) {
          firstPrTask = JSON.parse(JSON.stringify(candidate));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let liveTask;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        liveTask = readTasks()[0];
        if (liveTask.stacked_prs?.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const duringRun = JSON.parse(JSON.stringify(liveTask));
      const completedDuringObservation = completed;
      await completion;
      console.log(JSON.stringify({
        firstPrTask,
        duringRun,
        completedDuringObservation,
        tasks: readTasks(),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.completedDuringObservation, false);
  assert.equal(result.firstPrTask.status, "in_progress");
  assert.equal(result.firstPrTask.pr_url, firstPrUrl);
  assert.equal(result.firstPrTask.branch_name, "agent/live-stack");
  assert.equal(result.firstPrTask.stacked_prs, undefined);
  assert.equal(result.duringRun.status, "in_progress");
  assert.equal(result.duringRun.pr_url, firstPrUrl);
  assert.equal(result.duringRun.branch_name, "agent/live-stack");
  assert.equal(result.duringRun.pr_url_provisional, true);
  assert.ok(
    result.duringRun.stacked_prs.every(
      (entry: NonNullable<Task["stacked_prs"]>[number]) => entry.provisional
    )
  );
  assert.deepEqual(
    result.duringRun.stacked_prs.map((entry: NonNullable<Task["stacked_prs"]>[number]) => ({
      position: entry.position,
      pr_url: entry.pr_url,
      branch_name: entry.branch_name,
      base_branch: entry.base_branch,
      scope: entry.scope,
      state: entry.state,
    })),
    [
      {
        position: 1,
        pr_url: firstPrUrl,
        branch_name: "agent/live-stack",
        base_branch: "main",
        scope: "Add live PR discovery",
        state: "open",
      },
      {
        position: 2,
        pr_url: secondPrUrl,
        branch_name: "agent/live-stack-2",
        base_branch: "agent/live-stack",
        scope: "Show live stacks in the task UI",
        state: "open",
      },
    ]
  );
});

test("spawnAgentSession does not wait for queued live PR lookups at exit", () => {
  const { workspace } = setupWorkspace();
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const ghStateFile = path.join(workspace, "gh-queued-live-pr-state.json");
  const callsFile = path.join(workspace, "gh-queued-live-pr-calls.jsonl");
  const pullRequests = Array.from({ length: 5 }, (_, index) => {
    const number = 90 + index;
    return {
      number,
      url: `https://github.com/farshidz/marqo-cortex-city/pull/${number}`,
      branch: `agent/queued-${index + 1}`,
      base: index === 0 ? "main" : `agent/queued-${index}`,
    };
  });
  writeJson(ghStateFile, {
    prs: Object.fromEntries(
      pullRequests.map((pullRequest) => [
        `farshidz/marqo-cortex-city#${pullRequest.number}`,
        {
          url: pullRequest.url,
          headRefName: pullRequest.branch,
          baseRefName: pullRequest.base,
          title: `Queued slice ${pullRequest.number}`,
        },
      ])
    ),
  });
  writeJson(scenarioFile, {
    codex: {
      stdoutChunks: [
        {
          text: pullRequests
            .map((pullRequest) =>
              JSON.stringify({
                type: "item.completed",
                item: {
                  type: "command_execution",
                  command: "gh pr create --base main",
                  aggregated_output: `${pullRequest.url}\n`,
                  status: "completed",
                },
              })
            )
            .join("\n") + "\n",
        },
      ],
      sleepMs: 150,
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        worktree_path: workspace,
      }))};
      await createTask(task);
      const startedAt = Date.now();
      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => resolve(undefined)).catch(reject);
      });
      console.log(JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        tasks: readTasks(),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
      FAKE_GH_CALLS_FILE: callsFile,
      FAKE_GH_PR_VIEW_DELAY_MS: "4000",
    }
  );
  const ghCalls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];

  assert.ok(result.elapsedMs < 1500, `completion took ${result.elapsedMs}ms`);
  assert.ok(ghCalls.length <= 1, `expected one coalesced lookup, saw ${ghCalls.length}`);
  assert.equal(result.tasks[0].status, "in_progress");
  assert.equal(result.tasks[0].pr_url, undefined);
});

test("live PR discovery rejects partial GitHub inspection results", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-partial-live-pr-state.json");
  const firstPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/41";
  const secondPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/42";
  const thirdPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/43";
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#41": {
        url: firstPrUrl,
        baseRefName: "main",
        title: "Unavailable lower PR",
      },
      "farshidz/marqo-cortex-city#42": {
        url: secondPrUrl,
        headRefName: "agent/partial-stack-2",
        baseRefName: "agent/partial-stack",
        title: "Existing upper PR",
      },
      "farshidz/marqo-cortex-city#43": {
        url: thirdPrUrl,
        headRefName: "agent/partial-stack-3",
        baseRefName: "agent/partial-stack-2",
        title: "New top PR",
      },
    },
  });
  const trackedStack = [
    {
      position: 1,
      pr_url: firstPrUrl,
      branch_name: "agent/partial-stack",
      base_branch: "main",
      scope: "Slice one",
      state: "open",
      provisional: true,
    },
    {
      position: 2,
      pr_url: secondPrUrl,
      branch_name: "agent/partial-stack-2",
      base_branch: "agent/partial-stack",
      scope: "Slice two",
      state: "open",
      provisional: true,
    },
  ];

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/41",
        branch_name: "agent/partial-stack",
        stacked_prs: trackedStack as Task["stacked_prs"],
        pr_url_provisional: true,
      }))};
      await createTask(task);
      await __testUtils.persistLivePullRequestProgress(
        task.id,
        ${JSON.stringify(workspace)},
        ${JSON.stringify([firstPrUrl, secondPrUrl, thirdPrUrl])},
        process.env
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.deepEqual(result.tasks[0].stacked_prs, trackedStack);
  assert.equal(result.tasks[0].pr_url, firstPrUrl);
  assert.equal(result.tasks[0].branch_name, "agent/partial-stack");
});

test("live PR discovery cannot overwrite state after review ownership begins", () => {
  const { workspace } = setupWorkspace();
  const ghStateFile = path.join(workspace, "gh-live-status-handoff-state.json");
  const firstPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/71";
  const secondPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/72";
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#71": {
        url: firstPrUrl,
        headRefName: "agent/handoff-one",
        baseRefName: "main",
        title: "Lower slice",
      },
      "farshidz/marqo-cortex-city#72": {
        url: secondPrUrl,
        headRefName: "agent/handoff-two",
        baseRefName: "agent/handoff-one",
        title: "Upper slice",
      },
    },
  });
  const lifecycleStack = [
    {
      position: 1,
      pr_url: firstPrUrl,
      branch_name: "agent/handoff-one",
      base_branch: "main",
      scope: "Lower slice",
      state: "merged",
      merge_commit_sha: "merge-71",
    },
    {
      position: 2,
      pr_url: secondPrUrl,
      branch_name: "agent/handoff-two",
      base_branch: "agent/worker-updated-base",
      scope: "Upper slice",
      state: "open",
      pending_restack_of: firstPrUrl,
    },
  ];

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({ status: "in_progress" }))};
      await createTask(task);
      const pending = __testUtils.persistLivePullRequestProgress(
        task.id,
        ${JSON.stringify(workspace)},
        ${JSON.stringify([firstPrUrl, secondPrUrl])},
        process.env
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      await updateTask(task.id, {
        status: "in_review",
        pr_url: ${JSON.stringify(secondPrUrl)},
        branch_name: "agent/handoff-two",
        stacked_prs: ${JSON.stringify(lifecycleStack)},
      });
      await pending;
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_GH_STATE_FILE: ghStateFile,
      FAKE_GH_PR_VIEW_DELAY_MS: "500",
    }
  );

  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].pr_url, secondPrUrl);
  assert.equal(result.tasks[0].branch_name, "agent/handoff-two");
  assert.deepEqual(result.tasks[0].stacked_prs, lifecycleStack);
});

test("final reports retract provisional stack entries they do not confirm", () => {
  const { workspace } = setupWorkspace();
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const ghStateFile = path.join(workspace, "gh-retracted-live-pr-state.json");
  const firstPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/61";
  const secondPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/62";
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#61": {
        url: firstPrUrl,
        headRefName: "agent/retracted-stack",
        headRefOid: "head-61",
        baseRefName: "main",
        title: "Confirmed single PR",
        state: "open",
        merged: false,
        reviews: [],
        comments: [],
        issueComments: [],
        checks: [],
      },
      "farshidz/marqo-cortex-city#62": {
        url: secondPrUrl,
        headRefName: "agent/retracted-stack-2",
        headRefOid: "head-62",
        baseRefName: "agent/retracted-stack",
        title: "Unconfirmed upper PR",
        state: "open",
        merged: false,
        reviews: [],
        comments: [],
        issueComments: [],
        checks: [],
      },
    },
  });
  const finalReport = {
    status: "completed",
    summary: "Confirmed only the bottom PR",
    pr_url: firstPrUrl,
    branch_name: "agent/retracted-stack",
    stacked_prs: null,
    files_changed: [],
    assumptions: [],
    blockers: [],
    next_steps: [],
    tool_calls: null,
  };
  writeJson(scenarioFile, {
    codex: {
      stdoutChunks: [
        {
          text: `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "gh pr create --base main",
              aggregated_output: `${firstPrUrl}\n`,
              status: "completed",
            },
          })}\n`,
        },
        {
          delayMs: 75,
          text: `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "gh pr create --base agent/retracted-stack",
              aggregated_output: `${secondPrUrl}\n`,
              status: "completed",
            },
          })}\n`,
        },
        {
          delayMs: 1500,
          text: `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(finalReport),
            },
          })}\n${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 },
          })}\n`,
        },
      ],
      sleepMs: 25,
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        worktree_path: workspace,
      }))};
      await createTask(task);
      const completion = new Promise((resolve, reject) => {
        spawnAgentSession(task, "initial", () => resolve(undefined)).catch(reject);
      });
      let provisionalTask;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const candidate = readTasks()[0];
        if (candidate.stacked_prs?.length === 2) {
          provisionalTask = JSON.parse(JSON.stringify(candidate));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await completion;
      console.log(JSON.stringify({ provisionalTask, tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.provisionalTask.stacked_prs.length, 2);
  assert.ok(
    result.provisionalTask.stacked_prs.every(
      (entry: NonNullable<Task["stacked_prs"]>[number]) => entry.provisional
    )
  );
  assert.equal(result.tasks[0].status, "in_review");
  assert.equal(result.tasks[0].pr_url, firstPrUrl);
  assert.equal(result.tasks[0].pr_url_provisional, undefined);
  assert.equal(result.tasks[0].stacked_prs, undefined);
});

test("review runs leave live PR discovery to the final report", () => {
  const { workspace } = setupWorkspace();
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const ghStateFile = path.join(workspace, "gh-review-pr-state.json");
  const callsFile = path.join(workspace, "gh-review-pr-calls.jsonl");
  const existingPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/51";
  const newPrUrl = "https://github.com/farshidz/marqo-cortex-city/pull/52";
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#51": {
        url: existingPrUrl,
        headRefName: "agent/review-existing",
        headRefOid: "head-51",
        baseRefName: "main",
        title: "Existing PR",
        state: "open",
        merged: false,
        reviews: [],
        comments: [],
        issueComments: [],
        checks: [],
      },
      "farshidz/marqo-cortex-city#52": {
        url: newPrUrl,
        headRefName: "agent/review-new",
        baseRefName: "agent/review-existing",
        title: "New PR",
      },
    },
  });
  writeJson(scenarioFile, {
    codex: {
      stdout: `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "gh pr create --base agent/review-existing",
          aggregated_output: `${newPrUrl}\n`,
          status: "completed",
        },
      })}\n`,
    },
  });

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_review",
        pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/51",
        branch_name: "agent/review-existing",
        worktree_path: workspace,
      }))};
      await createTask(task);
      await new Promise((resolve, reject) => {
        spawnAgentSession(task, "review", () => resolve(undefined)).catch(reject);
      });
      const calls = require("node:fs").readFileSync(${JSON.stringify(callsFile)}, "utf-8")
        .trim()
        .split(/\\n/)
        .filter(Boolean)
        .map(JSON.parse);
      console.log(JSON.stringify({ tasks: readTasks(), calls }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
      FAKE_GH_CALLS_FILE: callsFile,
    }
  );

  assert.equal(result.tasks[0].pr_url, existingPrUrl);
  assert.equal(result.tasks[0].stacked_prs, undefined);
  assert.equal(
    result.calls.some((args: string[]) => args.includes(newPrUrl)),
    false
  );
});

test("handleRunComplete uses Codex session deltas instead of re-adding cumulative usage", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_review",
        session_id: "thread-codex",
        codex_usage_session_id: "thread-codex",
        codex_cumulative_input_tokens: 100,
        codex_cumulative_cached_input_tokens: 80,
        codex_cumulative_output_tokens: 20,
        total_input_tokens: 100,
        total_cached_input_tokens: 80,
        total_output_tokens: 20,
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        "",
        "",
        65,
        [],
        "codex",
        "review",
        {
          type: "codex",
          subtype: "exec",
          is_error: false,
          duration_ms: 0,
          result: JSON.stringify({
            status: "needs_review",
            summary: "Kept the existing PR current",
            pr_url: "",
            branch_name: "agent/codex-cumulative",
            files_changed: [],
            assumptions: [],
            blockers: [],
            next_steps: [],
          }),
          session_id: "thread-codex",
          terminal_reason: "completed",
          total_cost_usd: 0,
          num_turns: 1,
          structured_output: {
            status: "needs_review",
            summary: "Kept the existing PR current",
            pr_url: "",
            branch_name: "agent/codex-cumulative",
            files_changed: [],
            assumptions: [],
            blockers: [],
            next_steps: [],
          },
          usage: {
            input_tokens: 140,
            cache_read_input_tokens: 110,
            output_tokens: 27,
          },
        }
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_input_tokens, 40);
  assert.equal(result.tasks[0].last_run_cached_input_tokens, 30);
  assert.equal(result.tasks[0].last_run_output_tokens, 7);
  assert.equal(result.tasks[0].total_input_tokens, 140);
  assert.equal(result.tasks[0].total_cached_input_tokens, 110);
  assert.equal(result.tasks[0].total_output_tokens, 27);
  assert.equal(result.tasks[0].codex_usage_session_id, "thread-codex");
  assert.equal(result.tasks[0].codex_cumulative_input_tokens, 140);
  assert.equal(result.tasks[0].codex_cumulative_cached_input_tokens, 110);
  assert.equal(result.tasks[0].codex_cumulative_output_tokens, 27);
});

test("handleRunComplete does not clear a newer task pid", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        current_run_pid: 2222,
      }))};
      await createTask(task);
      await __testUtils.handleRunComplete(
        "task-1",
        0,
        "",
        "",
        65,
        [],
        "codex",
        "initial",
        {
          type: "codex",
          subtype: "exec",
          is_error: false,
          duration_ms: 0,
          result: JSON.stringify({
            status: "completed",
            summary: "Original run completed after a new run started",
            pr_url: "",
            branch_name: "agent/stale-pid",
            files_changed: [],
            assumptions: [],
            blockers: [],
            next_steps: [],
          }),
          session_id: "thread-codex",
          terminal_reason: "completed",
          total_cost_usd: 0,
          num_turns: 1,
          structured_output: {
            status: "completed",
            summary: "Original run completed after a new run started",
            pr_url: "",
            branch_name: "agent/stale-pid",
            files_changed: [],
            assumptions: [],
            blockers: [],
            next_steps: [],
          },
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 0,
            output_tokens: 4,
          },
        },
        1111
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "success");
  assert.equal(result.tasks[0].current_run_pid, 2222);
});

test("handleRunTimeout preserves Codex usage already observed before timeout", () => {
  const { workspace } = setupWorkspace();
  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        status: "in_progress",
        session_id: "thread-timeout",
      }))};
      await createTask(task);
      await __testUtils.handleRunTimeout(
        "task-1",
        42,
        50,
        "codex",
        {
          type: "codex",
          subtype: "exec",
          is_error: false,
          duration_ms: 0,
          result: "",
          session_id: "thread-timeout",
          terminal_reason: "completed",
          total_cost_usd: 0,
          num_turns: 1,
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 9,
            output_tokens: 3,
          },
        }
      );
      console.log(JSON.stringify({ tasks: readTasks() }));
    `
  );

  assert.equal(result.tasks[0].last_run_result, "timeout");
  assert.equal(result.tasks[0].last_run_input_tokens, 12);
  assert.equal(result.tasks[0].last_run_cached_input_tokens, 9);
  assert.equal(result.tasks[0].last_run_output_tokens, 3);
  assert.equal(result.tasks[0].total_input_tokens, 12);
  assert.equal(result.tasks[0].total_cached_input_tokens, 9);
  assert.equal(result.tasks[0].total_output_tokens, 3);
  assert.equal(result.tasks[0].codex_usage_session_id, "thread-timeout");
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

test("ensureManagedRepo clones repo state under .cortex/repos", () => {
  const gitWorkspace = createTempWorkspace("agent-runner-managed-clone-");
  const { remotePath } = initGitTestRepo(gitWorkspace);
  const { workspace } = setupWorkspace();

  const result = runAgentRunnerScript(
    workspace,
    `
      const { execFileSync } = require("node:child_process");
      const { readFileSync } = require("node:fs");
      const path = require("node:path");
      const repoPath = await __testUtils.ensureManagedRepo(
        "managed-agent",
        {
          name: "Managed Agent",
          repo_slug: ${JSON.stringify(remotePath)},
          prompt_file: "prompts/agents/cortex-city-swe.md",
          default_branch: "main",
        },
        "main"
      );
      const remote = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
        encoding: "utf-8",
      }).trim();
      const gitignore = readFileSync(path.join(${JSON.stringify(workspace)}, ".cortex", ".gitignore"), "utf-8");
      console.log(JSON.stringify({ repoPath, remote, gitignore }));
    `
  );

  assert.ok(
    result.repoPath.startsWith(path.join(realpathSync(workspace), ".cortex", "repos"))
  );
  assert.equal(result.remote, remotePath);
  assert.match(result.gitignore, /(^|\n)repos\/\n/);
});

test("spawnAgentSession ignores legacy repo_path, clones a managed repo, and uses the configured working directory", () => {
  const gitWorkspace = createTempWorkspace("agent-runner-managed-workdir-");
  const { remotePath, repoPath } = initGitTestRepo(gitWorkspace);
  mkdirSync(path.join(repoPath, "packages", "api"), { recursive: true });
  writeFileSync(path.join(repoPath, "packages", "api", "package.json"), "{}\n");
  execFileSync("git", ["-C", repoPath, "add", "packages/api/package.json"]);
  execFileSync("git", ["-C", repoPath, "commit", "-m", "Add package workspace"]);
  execFileSync("git", ["-C", repoPath, "push", "origin", "main"]);

  const { workspace } = setupWorkspace();
  writeTestConfig(workspace, {}, {
    "cortex-city-swe": {
      repo_path: path.join(workspace, "legacy-repo-path-must-be-ignored"),
      repo_slug: remotePath,
      working_directory: "packages/api",
      default_branch: "main",
    },
  });
  const argsFile = path.join(workspace, "managed-workdir-args.json");
  const report = {
    status: "completed",
    summary: "Ran from the package workspace",
    pr_url: "",
    branch_name: "agent/managed-workdir",
    files_changed: [],
    assumptions: [],
    blockers: [],
    next_steps: [],
  };

  const result = runAgentRunnerScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask({
        title: "Managed repo workdir",
      }))};
      await createTask(task);
      process.env.FAKE_AGENT_ARGS_FILE = ${JSON.stringify(argsFile)};
      process.env.FAKE_AGENT_STDOUT = ${JSON.stringify(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-managed" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(report),
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
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

  assert.ok(result.args.cwd.endsWith(path.join("packages", "api")));
  const managedReposPath = path.join(realpathSync(workspace), ".cortex", "repos");
  assert.ok(result.args.cwd.startsWith(managedReposPath));
  assert.ok(result.tasks[0].worktree_path.startsWith(managedReposPath));
  assert.equal(result.tasks[0].last_run_result, "success");
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

test("ensureWorktree creates a fallback branch for auto-derived local branch collisions", () => {
  const workspace = createTempWorkspace("agent-runner-local-collision-");
  const { repoPath } = initGitTestRepo(workspace);
  execFileSync("git", ["-C", repoPath, "branch", "agent/existing-branch", "main"]);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Existing branch",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ branch, tasks: readTasks(), worktreePath }));
    `
  );

  assert.equal(result.branch, "agent/existing-branch-2");
  assert.equal(result.tasks[0].branch_name, "agent/existing-branch-2");
  assert.match(result.worktreePath, /existing-branch-2$/);
});

test("ensureWorktree creates a fallback branch for auto-derived remote branch collisions", () => {
  const workspace = createTempWorkspace("agent-runner-remote-collision-");
  const { repoPath } = initGitTestRepo(workspace);
  execFileSync("git", ["-C", repoPath, "checkout", "-b", "agent/remote-conflict", "main"]);
  execFileSync("git", ["-C", repoPath, "push", "origin", "agent/remote-conflict"]);
  execFileSync("git", ["-C", repoPath, "checkout", "main"]);
  execFileSync("git", ["-C", repoPath, "branch", "-D", "agent/remote-conflict"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "update-ref",
    "-d",
    "refs/remotes/origin/agent/remote-conflict",
  ]);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Remote conflict",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ branch, tasks: readTasks() }));
    `
  );

  assert.equal(result.branch, "agent/remote-conflict-2");
  assert.equal(result.tasks[0].branch_name, "agent/remote-conflict-2");
});

test("ensureWorktree creates a fallback path for auto-derived worktree path collisions", () => {
  const workspace = createTempWorkspace("agent-runner-path-collision-");
  const { repoPath } = initGitTestRepo(workspace);
  mkdirSync(path.join(repoPath, "..", ".worktrees", "repeated-title"), {
    recursive: true,
  });
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Repeated title",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(task, ${JSON.stringify(repoPath)}, "main");
      const branch = execFileSync("git", ["-C", worktreePath, "branch", "--show-current"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ branch, tasks: readTasks(), worktreePath }));
    `
  );

  assert.equal(result.branch, "agent/repeated-title-2");
  assert.equal(result.tasks[0].branch_name, "agent/repeated-title-2");
  assert.match(result.worktreePath, /repeated-title-2$/);
});

test("ensureWorktree configures the requested Git author identity locally", () => {
  const workspace = createTempWorkspace("agent-runner-git-identity-");
  const { repoPath } = initGitTestRepo(workspace);
  const setup = setupWorkspace({ repoPath });

  const result = runAgentRunnerScript(
    setup.workspace,
    `
      const { execFileSync } = require("node:child_process");
      const task = ${JSON.stringify(sampleTask({
        title: "Configure git identity",
      }))};
      await createTask(task);
      const worktreePath = await __testUtils.ensureWorktree(
        task,
        ${JSON.stringify(repoPath)},
        "main",
        { name: "Agent Bot", email: "agent@example.com" }
      );
      const name = execFileSync("git", ["-C", worktreePath, "config", "--local", "user.name"], {
        encoding: "utf-8",
      }).trim();
      const email = execFileSync("git", ["-C", worktreePath, "config", "--local", "user.email"], {
        encoding: "utf-8",
      }).trim();
      console.log(JSON.stringify({ name, email, tasks: readTasks() }));
    `
  );

  assert.equal(result.name, "Agent Bot");
  assert.equal(result.email, "agent@example.com");
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
      await removeWorktree(task);
      console.log(JSON.stringify({ ok: true }));
    `
  );

  assert.equal(result.ok, true);
});
