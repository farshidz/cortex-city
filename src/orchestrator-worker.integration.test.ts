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
const REVIEW_STORE_MODULE_URL = moduleUrl("src/lib/review-store.ts");

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
      `import { readReviewSummaryMap, upsertReviewSummary } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
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
      sleepMs: 2000,
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
      sleepMs: 2000,
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
        // This fixture isolates the implementation agent's GitHub-feedback
        // scan. Unified automatic-review behavior has dedicated worker tests.
        task.reviewer_agent_enabled = false;
        task.worktree_path = ${JSON.stringify(workspace)};
        await createTask(task);
      }

      await pollOnce(activePids);
      for (let i = 0; i < 20; i++) {
        const current = readTasks();
        const manualDone = current.find((task) => task.id === "review-manual")?.last_run_result;
        const conflictDone = current.find((task) => task.id === "review-conflicts")?.last_run_result;
        if (manualDone && conflictDone) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
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

test("reviewer decision prompts wait for a human response before waking the task builder", () => {
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_sessions: 1,
    },
  });
  const scenarioFile = path.join(workspace, "decision-response-scenario.json");
  const callsFile = path.join(workspace, "decision-response-calls.jsonl");
  const ghStateFile = path.join(workspace, "decision-response-gh-state.json");
  const prUrl = "https://github.com/farshidz/marqo-cortex-city/pull/40";
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        type: "result",
        subtype: "print",
        is_error: false,
        duration_ms: 10,
        result: JSON.stringify({
          status: "needs_review",
          summary: "human response handled",
          pr_url: prUrl,
          branch_name: "agent/human-response",
          files_changed: [],
          assumptions: [],
          blockers: [],
          next_steps: [],
        }),
        session_id: "claude-human-response-session",
        terminal_reason: "completed",
        total_cost_usd: 0,
        num_turns: 1,
        structured_output: {
          status: "needs_review",
          summary: "human response handled",
          pr_url: prUrl,
          branch_name: "agent/human-response",
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
      "farshidz/marqo-cortex-city#40": {
        state: "open",
        merged: false,
        mergeable_state: "clean",
        mergeable: true,
        headRefOid: "decision-head",
        reviews: [],
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
      const pendingToken = "11111111-1111-4111-8111-111111111111";
      const baselineHash = await getPRStateHash(${JSON.stringify(prUrl)});
      await createTask({
        ...${JSON.stringify(sampleTask({
          id: "human-decision-task",
          status: "in_review",
          agent_runner: "claude",
          reviewer_agent_enabled: false,
          pr_url: prUrl,
          worktree_path: workspace,
        }))},
        last_review_gh_state: baselineHash,
      });
      await upsertReviewSummary({
        source: "task",
        task_id: "human-decision-task",
        pr_url: ${JSON.stringify(prUrl)},
        pr_number: 40,
        repo_slug: "farshidz/marqo-cortex-city",
        title: "Choose an implementation",
        author: "farshidz",
        head_sha: "decision-head",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
        summary: "A human decision is required.",
        generated_at: "2026-05-01T00:10:00.000Z",
        pending_reviewer_human_decision_comment_token: pendingToken,
      });

      const fs = require("node:fs");
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(ghStateFile)}, "utf-8"));
      const pr = state.prs["farshidz/marqo-cortex-city#40"];
      pr.issueComments = [{
        id: 400,
        body: "**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A or B.\\n\\n<!-- cortex-city-review-decision:" + pendingToken + " -->",
      }];
      fs.writeFileSync(${JSON.stringify(ghStateFile)}, JSON.stringify(state));

      await pollOnce(activePids);
      const afterReviewerPrompt = readTasks()[0];
      const reviewAfterReviewerPrompt = readReviewSummaryMap()[${JSON.stringify(prUrl)}];
      const callsAfterReviewerPrompt = fs.existsSync(${JSON.stringify(callsFile)})
        ? fs.readFileSync(${JSON.stringify(callsFile)}, "utf-8").trim().split(/\\r?\\n/).filter(Boolean).length
        : 0;

      pr.issueComments.push({ id: 401, body: "Choose A." });
      fs.writeFileSync(${JSON.stringify(ghStateFile)}, JSON.stringify(state));
      await pollOnce(activePids);
      for (let i = 0; i < 20; i++) {
        if (readTasks()[0]?.last_run_result) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const calls = fs.existsSync(${JSON.stringify(callsFile)})
        ? fs.readFileSync(${JSON.stringify(callsFile)}, "utf-8").trim().split(/\\r?\\n/).filter(Boolean)
        : [];
      console.log(JSON.stringify({
        afterReviewerPrompt,
        reviewAfterReviewerPrompt,
        callsAfterReviewerPrompt,
        finalTask: readTasks()[0],
        callCount: calls.length,
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_CALLS_FILE: callsFile,
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(result.afterReviewerPrompt.last_run_result, undefined);
  assert.equal(result.callsAfterReviewerPrompt, 0);
  assert.deepEqual(
    result.reviewAfterReviewerPrompt.reviewer_human_decision_comment_ids,
    [400]
  );
  assert.equal(
    result.reviewAfterReviewerPrompt.pending_reviewer_human_decision_comment_token,
    "11111111-1111-4111-8111-111111111111"
  );
  assert.equal(result.finalTask.last_run_result, "success");
  assert.equal(result.callCount, 1);
});

test("pollOnce rebuilds a crashed human-decision review without duplicating its comment", () => {
  const workspace = setupWorkspace({
    configOverrides: {
      max_parallel_reviews: 1,
      review_runtime: "claude",
    },
  });
  const prUrl = "https://github.com/farshidz/marqo-cortex-city/pull/41";
  const scenarioFile = path.join(workspace, "decision-retry-scenario.json");
  const ghStateFile = path.join(workspace, "decision-retry-gh-state.json");
  const pendingToken = "11111111-1111-4111-8111-111111111111";
  const interruptedError =
    "The reviewer human-decision comment action was interrupted before its receipt was saved.";
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "decision-retry-session",
        result: [
          "## Summary",
          "Rebuilt after the interrupted comment action.",
          "## Agent Status",
          "Agent status: `needs_human_decision`",
          "## Human Decision",
          "Choose A or B before merging.",
        ].join("\n"),
        is_error: false,
      }),
      sleepMs: 10,
    },
  });
  writeJson(ghStateFile, {
    prs: {
      "farshidz/marqo-cortex-city#41": {
        state: "open",
        merged: false,
        mergeable_state: "clean",
        mergeable: true,
        headRefOid: "decision-retry-head",
        reviews: [],
        comments: [],
        issueComments: [
          {
            id: 410,
            body: `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose the legacy path.\n\n<!-- cortex-city-review-decision:${pendingToken} -->`,
          },
        ],
        nextIssueCommentId: 500,
        checks: [{ name: "ci", state: "SUCCESS" }],
      },
    },
  });

  const result = runWorkerScript(
    workspace,
    `
      const activePids = new Map();
      await upsertReviewSummary({
        source: "task",
        task_id: "decision-retry-task",
        task_title: "Recover a human decision",
        task_description: "Rebuild the review result after an interrupted comment action.",
        task_plan: "Reconcile the receipt, then rerun the reviewer.",
        pr_url: ${JSON.stringify(prUrl)},
        pr_number: 41,
        repo_slug: "farshidz/marqo-cortex-city",
        title: "Recover a human decision",
        author: "farshidz",
        head_sha: "decision-retry-head",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
        summary: "Old clean summary.",
        summary_head_sha: "decision-retry-head",
        generated_at: "2026-05-01T00:10:00.000Z",
        agent_review_status: "ready_for_human_approval",
        pending_reviewer_human_decision_comment_token: ${JSON.stringify(pendingToken)},
        error: ${JSON.stringify(interruptedError)},
        error_at: "2026-05-01T00:10:00.000Z",
      });
      const baselineHash = await getPRStateHash(${JSON.stringify(prUrl)});
      await createTask({
        ...${JSON.stringify(sampleTask({
          id: "decision-retry-task",
          title: "Recover a human decision",
          description: "Rebuild the review result after an interrupted comment action.",
          plan: "Reconcile the receipt, then rerun the reviewer.",
          status: "in_review",
          agent_runner: "claude",
          reviewer_agent_enabled: true,
          pr_url: prUrl,
          worktree_path: workspace,
        }))},
        last_review_gh_state: baselineHash,
      });

      await pollOnce(activePids);
      for (let i = 0; i < 30; i++) {
        const review = readReviewSummaryMap()[${JSON.stringify(prUrl)}];
        if (review?.summary_head_sha === "decision-retry-head" &&
            review?.summary?.includes("Rebuilt after") &&
            review?.current_run_pid == null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const fs = require("node:fs");
      console.log(JSON.stringify({
        review: readReviewSummaryMap()[${JSON.stringify(prUrl)}],
        task: readTasks()[0],
        ghState: JSON.parse(fs.readFileSync(${JSON.stringify(ghStateFile)}, "utf-8")),
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
      FAKE_GH_STATE_FILE: ghStateFile,
    }
  );

  assert.equal(
    result.review.summary,
    [
      "## Summary",
      "Rebuilt after the interrupted comment action.",
      "## Agent Status",
      "Agent status: `needs_human_decision`",
      "## Human Decision",
      "Choose A or B before merging.",
    ].join("\n")
  );
  assert.equal(result.review.summary_head_sha, "decision-retry-head");
  assert.equal(result.review.agent_review_status, "needs_human_decision");
  assert.deepEqual(result.review.reviewer_human_decision_comment_ids, [410]);
  assert.equal(
    result.review.pending_reviewer_human_decision_comment_token,
    undefined
  );
  assert.equal(result.review.error, undefined);
  assert.equal(result.task.last_run_result, undefined);
  assert.equal(
    result.ghState.prs["farshidz/marqo-cortex-city#41"].issueComments.length,
    1
  );
  assert.equal(
    result.ghState.prs["farshidz/marqo-cortex-city#41"].issueComments[0].body,
    `**🤖[Cortex City Reviewer]** **Human decision needed:** Choose A or B before merging.\n\n<!-- cortex-city-review-decision:${pendingToken} -->`
  );
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
  const staleCleanupWorktreePath = path.join(workspaceRoot, "stale-cleanup-worktree");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "agent/stale-cleanup", staleCleanupWorktreePath, "origin/main"]);
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
        id: "stale-cleanup-task",
        status: "closed",
        agent_runner: "claude",
        branch_name: "agent/stale-cleanup",
        worktree_path: staleCleanupWorktreePath,
        final_cleanup_state: "running",
      }))});
      await createTask(${JSON.stringify(sampleTask({
        id: "prune-me",
        status: "closed",
        updated_at: "2026-04-14T00:00:00.000Z",
      }))});
      await createTask(${JSON.stringify(sampleTask({
        id: "keep-recent-final-task",
        status: "closed",
        updated_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
      }))});

      await pollOnce(activePids);
      for (let attempt = 0; attempt < 20; attempt++) {
        const cleanupTask = readTasks().find((task) => task.id === "cleanup-task");
        const staleCleanupTask = readTasks().find((task) => task.id === "stale-cleanup-task");
        if (
          cleanupTask?.final_cleanup_state === "finished" &&
          !cleanupTask.worktree_path &&
          staleCleanupTask?.final_cleanup_state === "finished" &&
          !staleCleanupTask.worktree_path
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
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
  const staleCleanupTask = result.tasks.find(
    (task: Task) => task.id === "stale-cleanup-task"
  );
  assert.equal(staleCleanupTask.final_cleanup_state, "finished");
  assert.equal(staleCleanupTask.worktree_path, undefined);
  assert.equal(
    result.tasks.some((task: Task) => task.id === "prune-me"),
    false
  );
  assert.equal(
    result.tasks.some((task: Task) => task.id === "keep-recent-final-task"),
    true
  );
  assert.equal(existsSync(cleanupWorktreePath), false);
  assert.equal(existsSync(staleCleanupWorktreePath), false);
  assert.equal(existsSync(path.join(logsDir, "task-prune-me-2026-04-10.log")), false);
  assert.equal(existsSync(path.join(logsDir, "task-prune-me-2026-04-10.jsonl")), false);
  assert.equal(existsSync(path.join(logsDir, "task-keep-me-2026-04-10.log")), true);
});
