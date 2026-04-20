import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { OrchestratorConfig, Task } from "./lib/types";
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
} from "./lib/test-harness";

const WORKER_RUNTIME_MODULE_URL = moduleUrl("src/lib/orchestrator-worker-runtime.ts");
const STORE_MODULE_URL = moduleUrl("src/lib/store.ts");
const GITHUB_MODULE_URL = moduleUrl("src/lib/github.ts");

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Worker integration task",
    description: "Exercise a real worker poll",
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
  const workspace = createTempWorkspace("worker-integration-");
  writePromptTemplates(workspace);
  writeAgentPrompts(workspace);
  writeFakeAgentBinary(workspace, "codex");
  writeFakeAgentBinary(workspace, "claude");
  writeFakeGhBinary(workspace);
  writeTestConfig(workspace, options.configOverrides, {
    "cortex-city-swe": {
      repo_path: options.repoPath ?? workspace,
      default_branch: "main",
    },
  });
  return workspace;
}

function runWorkerScript(
  workspace: string,
  body: string,
  env: NodeJS.ProcessEnv = prependBinToPath(workspace)
) {
  return runTsxScript(
    workspace,
    [
      `import { pollOnce } from ${JSON.stringify(WORKER_RUNTIME_MODULE_URL)};`,
      `import { createTask, readTasks } from ${JSON.stringify(STORE_MODULE_URL)};`,
      `import { getPRStateHash } from ${JSON.stringify(GITHUB_MODULE_URL)};`,
    ],
    body,
    env
  );
}

test("pollOnce picks the oldest eligible open task and still accepts manual instructions on open tasks with sessions", () => {
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_sessions: 2,
    },
  });
  const scenarioFile = path.join(workspace, "agent-scenario.json");
  const callsFile = path.join(workspace, "agent-calls.jsonl");
  writeJson(scenarioFile, {
    codex: {
      sleepMs: 300,
    },
  });

  const oldestWorktree = path.join(workspace, "oldest");
  const manualWorktree = path.join(workspace, "manual");
  const youngerWorktree = path.join(workspace, "younger");
  const staleWorktree = path.join(workspace, "stale");
  mkdirSync(oldestWorktree, { recursive: true });
  mkdirSync(manualWorktree, { recursive: true });
  mkdirSync(youngerWorktree, { recursive: true });
  mkdirSync(staleWorktree, { recursive: true });

  const result = runWorkerScript(
    workspace,
    `
      const activePids = new Map();
      const tasks = [
        ${JSON.stringify(sampleTask({
          id: "open-oldest",
          title: "Open oldest",
          status: "open",
          created_at: "2026-04-15T00:00:00.000Z",
          updated_at: "2026-04-15T00:00:00.000Z",
          worktree_path: oldestWorktree,
        }))},
        ${JSON.stringify(sampleTask({
          id: "open-manual",
          title: "Open manual",
          status: "open",
          session_id: "thread-manual",
          pending_manual_instruction: "Apply reviewer notes",
          created_at: "2026-04-15T00:01:00.000Z",
          updated_at: "2026-04-15T00:01:00.000Z",
          worktree_path: manualWorktree,
        }))},
        ${JSON.stringify(sampleTask({
          id: "open-younger",
          title: "Open younger",
          status: "open",
          created_at: "2026-04-15T00:02:00.000Z",
          updated_at: "2026-04-15T00:02:00.000Z",
          worktree_path: youngerWorktree,
        }))},
        ${JSON.stringify(sampleTask({
          id: "open-stale-session",
          title: "Open stale session",
          status: "open",
          session_id: "thread-stale",
          created_at: "2026-04-15T00:03:00.000Z",
          updated_at: "2026-04-15T00:03:00.000Z",
          worktree_path: staleWorktree,
        }))},
      ];
      for (const task of tasks) {
        await createTask(task);
      }

      await pollOnce(activePids);
      const tasksAfterPoll = readTasks();
      const pids = tasksAfterPoll.map((task) => task.current_run_pid).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const calls = require("node:fs").existsSync(${JSON.stringify(callsFile)})
        ? require("node:fs")
            .readFileSync(${JSON.stringify(callsFile)}, "utf-8")
            .trim()
            .split(/\\r?\\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      console.log(JSON.stringify({ tasks: tasksAfterPoll, calls }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_CALLS_FILE: callsFile,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  const taskById = Object.fromEntries(result.tasks.map((task: Task) => [task.id, task]));
  assert.equal(taskById["open-oldest"].status, "in_progress");
  assert.equal(typeof taskById["open-oldest"].current_run_pid, "number");
  assert.equal(taskById["open-manual"].status, "in_progress");
  assert.equal(typeof taskById["open-manual"].current_run_pid, "number");
  assert.equal(taskById["open-younger"].status, "open");
  assert.equal(taskById["open-stale-session"].status, "open");
});

test("pollOnce reconciles orphaned pids, resumes eligible work, and leaves final tasks non-resumable", () => {
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_sessions: 1,
    },
  });
  const scenarioFile = path.join(workspace, "resume-scenario.json");
  const callsFile = path.join(workspace, "resume-calls.jsonl");
  writeJson(scenarioFile, {
    codex: {
      sleepMs: 300,
    },
  });

  const resumableWorktree = path.join(workspace, "resume-worktree");
  const blockedWorktree = path.join(workspace, "blocked-worktree");
  mkdirSync(resumableWorktree, { recursive: true });
  mkdirSync(blockedWorktree, { recursive: true });

  const result = runWorkerScript(
    workspace,
    `
      const activePids = new Map();
      const tasks = [
        ${JSON.stringify(sampleTask({
          id: "resume-open",
          title: "Resume open",
          status: "open",
          session_id: "thread-resume",
          current_run_pid: 999999,
          worktree_path: resumableWorktree,
        }))},
        ${JSON.stringify(sampleTask({
          id: "blocked-open",
          title: "Blocked open",
          status: "open",
          worktree_path: blockedWorktree,
          created_at: "2026-04-15T00:01:00.000Z",
          updated_at: "2026-04-15T00:01:00.000Z",
        }))},
        ${JSON.stringify(sampleTask({
          id: "final-task",
          title: "Final task",
          status: "merged",
          current_run_pid: 999998,
        }))},
      ];
      for (const task of tasks) {
        await createTask(task);
      }

      await pollOnce(activePids);
      const tasksAfterPoll = readTasks();
      const pids = tasksAfterPoll.map((task) => task.current_run_pid).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const calls = require("node:fs").existsSync(${JSON.stringify(callsFile)})
        ? require("node:fs")
            .readFileSync(${JSON.stringify(callsFile)}, "utf-8")
            .trim()
            .split(/\\r?\\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      console.log(JSON.stringify({ tasks: tasksAfterPoll, calls }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_CALLS_FILE: callsFile,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  const taskById = Object.fromEntries(result.tasks.map((task: Task) => [task.id, task]));
  assert.equal(taskById["resume-open"].status, "in_progress");
  assert.equal(typeof taskById["resume-open"].current_run_pid, "number");
  assert.equal(taskById["resume-open"].resume_requested, undefined);
  assert.equal(taskById["blocked-open"].status, "open");
  assert.equal(taskById["final-task"].current_run_pid, undefined);
  assert.equal(taskById["final-task"].resume_requested, undefined);
});

test("pollOnce scans in-review tasks for merged, closed, pending, conflicts, unchanged hashes, and manual reruns", () => {
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_sessions: 6,
      default_agent_runner: "claude",
    },
  });
  const scenarioFile = path.join(workspace, "review-scenario.json");
  const callsFile = path.join(workspace, "review-calls.jsonl");
  const ghStateFile = path.join(workspace, "review-gh-state.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        type: "result",
        subtype: "print",
        is_error: false,
        duration_ms: 10,
        result: JSON.stringify({
          status: "needs_review",
          summary: "review rerun complete",
          pr_url: "",
          branch_name: "agent/review-pass",
          files_changed: [],
          assumptions: [],
          blockers: [],
          next_steps: [],
        }),
        session_id: "claude-review-session",
        terminal_reason: "completed",
        total_cost_usd: 0,
        num_turns: 1,
        structured_output: {
          status: "needs_review",
          summary: "review rerun complete",
          pr_url: "",
          branch_name: "agent/review-pass",
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
      }),
      sleepMs: 10,
    },
  });
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#31": { state: "open", merged: true },
      "farshidz/marqo-cortex-city#32": { state: "closed", merged: false },
      "farshidz/marqo-cortex-city#33": {
        state: "open",
        merged: false,
        mergeable_state: "blocked",
        mergeable: false,
        headRefOid: "pending1",
        reviews: [{ id: 1, state: "COMMENTED" }],
        comments: [],
        issueComments: [],
        checks: [{ name: "ci", state: "IN_PROGRESS" }],
      },
      "farshidz/marqo-cortex-city#34": {
        state: "open",
        merged: false,
        mergeable_state: "blocked",
        mergeable: false,
        headRefOid: "manual1",
        reviews: [{ id: 2, state: "COMMENTED" }],
        comments: [],
        issueComments: [],
        checks: [{ name: "ci", state: "IN_PROGRESS" }],
      },
      "farshidz/marqo-cortex-city#35": {
        state: "open",
        merged: false,
        mergeable_state: "dirty",
        mergeable: false,
        headRefOid: "conflict1",
        reviews: [{ id: 3, state: "COMMENTED" }],
        comments: [],
        issueComments: [],
        checks: [{ name: "ci", state: "SUCCESS" }],
      },
      "farshidz/marqo-cortex-city#36": {
        state: "open",
        merged: false,
        mergeable_state: "clean",
        mergeable: true,
        headRefOid: "unchanged1",
        reviews: [{ id: 4, state: "COMMENTED" }],
        comments: [],
        issueComments: [],
        checks: [{ name: "ci", state: "SUCCESS" }],
      },
    },
  });

  const result = runWorkerScript(
    workspace,
    `
      const activePids = new Map();
      const unchangedHash = await getPRStateHash("https://github.com/farshidz/marqo-cortex-city/pull/36");
      const conflictHash = await getPRStateHash("https://github.com/farshidz/marqo-cortex-city/pull/35");
      const tasks = [
        ${JSON.stringify(sampleTask({
          id: "review-merged",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/31",
        }))},
        ${JSON.stringify(sampleTask({
          id: "review-closed",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/32",
        }))},
        ${JSON.stringify(sampleTask({
          id: "review-pending",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/33",
        }))},
        ${JSON.stringify(sampleTask({
          id: "review-manual",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/34",
          pending_manual_instruction: "Address the reviewer comment",
        }))},
        ${JSON.stringify(sampleTask({
          id: "review-conflicts",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/35",
        }))},
        ${JSON.stringify(sampleTask({
          id: "review-unchanged",
          status: "in_review",
          agent_runner: "claude",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/36",
        }))},
      ];
      tasks[4].last_review_gh_state = conflictHash;
      tasks[5].last_review_gh_state = unchangedHash;
      for (const task of tasks) {
        task.worktree_path = ${JSON.stringify(workspace)};
        await createTask(task);
      }

      await pollOnce(activePids);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const calls = require("node:fs").existsSync(${JSON.stringify(callsFile)})
        ? require("node:fs")
            .readFileSync(${JSON.stringify(callsFile)}, "utf-8")
            .trim()
            .split(/\\r?\\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      console.log(JSON.stringify({ tasks: readTasks(), calls }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_CALLS_FILE: callsFile,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  const taskById = Object.fromEntries(result.tasks.map((task: Task) => [task.id, task]));
  assert.equal(taskById["review-merged"].status, "merged");
  assert.equal(taskById["review-closed"].status, "closed");
  assert.equal(taskById["review-pending"].pr_status, "checks_pending");
  assert.equal(taskById["review-pending"].last_run_result, undefined);
  assert.equal(taskById["review-manual"].last_run_result, "success");
  assert.equal(taskById["review-manual"].pending_manual_instruction, undefined);
  assert.equal(taskById["review-conflicts"].pr_status, "conflicts");
  assert.equal(taskById["review-conflicts"].last_run_result, "success");
  assert.equal(taskById["review-unchanged"].last_run_result, undefined);
});

test("pollOnce runs final cleanup, removes worktrees, and prunes old task logs", () => {
  const workspaceRoot = createTempWorkspace("worker-cleanup-");
  const { repoPath } = initGitTestRepo(workspaceRoot);
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_sessions: 4,
      default_agent_runner: "claude",
    },
    repoPath,
  });
  const scenarioFile = path.join(workspace, "cleanup-scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        type: "result",
        subtype: "print",
        is_error: false,
        duration_ms: 10,
        result: JSON.stringify({
          status: "completed",
          summary: "cleanup complete",
          pr_url: "",
          branch_name: "agent/cleanup",
          files_changed: [],
          assumptions: [],
          blockers: [],
          next_steps: [],
        }),
        session_id: "claude-cleanup-session",
        terminal_reason: "completed",
        total_cost_usd: 0,
        num_turns: 1,
        structured_output: {
          status: "completed",
          summary: "cleanup complete",
          pr_url: "",
          branch_name: "agent/cleanup",
          files_changed: [],
          assumptions: [],
          blockers: [],
          next_steps: [],
        },
      }),
      sleepMs: 10,
    },
  });

  const cleanupWorktreePath = path.join(workspaceRoot, "cleanup-worktree");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "agent/cleanup", cleanupWorktreePath, "origin/main"]);
  const logsDir = path.join(workspace, "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(path.join(logsDir, "task-prune-me-2026-04-10.log"), "old log");
  writeFileSync(path.join(logsDir, "task-prune-me-2026-04-10.jsonl"), "old machine log");
  writeFileSync(path.join(logsDir, "task-keep-me-2026-04-10.log"), "keep log");

  const result = runWorkerScript(
    workspace,
    `
      const activePids = new Map();
      await createTask(${JSON.stringify(sampleTask({
        id: "cleanup-task",
        status: "merged",
        agent_runner: "claude",
        branch_name: "agent/cleanup",
        worktree_path: cleanupWorktreePath,
      }))});
      await createTask(${JSON.stringify(sampleTask({
        id: "prune-me",
        status: "closed",
        updated_at: "2026-04-14T00:00:00.000Z",
      }))});

      await pollOnce(activePids);
      await new Promise((resolve) => setTimeout(resolve, 120));
      console.log(JSON.stringify({ tasks: readTasks() }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  const cleanupTask = result.tasks.find((task: Task) => task.id === "cleanup-task");
  assert.equal(cleanupTask.final_cleanup_state, "finished");
  assert.equal(cleanupTask.worktree_path, undefined);
  assert.equal(
    result.tasks.some((task: Task) => task.id === "prune-me"),
    false
  );
  assert.equal(existsSync(cleanupWorktreePath), false);
  assert.equal(existsSync(path.join(logsDir, "task-prune-me-2026-04-10.log")), false);
  assert.equal(existsSync(path.join(logsDir, "task-prune-me-2026-04-10.jsonl")), false);
  assert.equal(existsSync(path.join(logsDir, "task-keep-me-2026-04-10.log")), true);
});
