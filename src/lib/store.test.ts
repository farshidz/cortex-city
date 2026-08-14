import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

function runStoreScript(workspace: string, body: string, timeout?: number) {
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
      timeout,
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
    task_run_timeout_ms: 7200000,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    review_learning_enabled: true,
    agents: {},
  });

  const configFile = path.join(workspace, ".cortex", "config.json");
  const gitignoreFile = path.join(workspace, ".cortex", ".gitignore");
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf-8")), config);
  assert.equal(
    readFileSync(gitignoreFile, "utf-8"),
    ".tasks.write.lock.*\norchestrator-state.json\n.env.*\n.env\nrepos/\nbackups/\n"
  );
});

test("readConfig appends missing default cortex gitignore entries", () => {
  const workspace = createTempWorkspace();
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  const gitignoreFile = path.join(workspace, ".cortex", ".gitignore");
  writeFileSync(gitignoreFile, "custom-state.json\n");

  runStoreScript(workspace, "console.log(JSON.stringify(store.readConfig()));");

  assert.equal(
    readFileSync(gitignoreFile, "utf-8"),
    "custom-state.json\n.tasks.write.lock.*\norchestrator-state.json\n.env.*\n.env\nrepos/\nbackups/\n"
  );
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
    task_run_timeout_ms: 7200000,
    default_permission_mode: "acceptEdits",
    default_agent_runner: "codex",
    review_learning_enabled: true,
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

test("updateTask merges concurrent writes without dropping earlier fields", () => {
  const workspace = createTempWorkspace();
  const task = sampleTask();

  const result = runStoreScript(
    workspace,
    `
      const task = ${JSON.stringify(task)};
      await store.createTask(task);
      await Promise.all([
        store.updateTask("task-1", {
          session_id: "thread-123",
        }),
        store.updateTask("task-1", {
          status: "in_review",
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/456",
        }),
      ]);
      console.log(JSON.stringify(store.readTasks()[0]));
    `
  );

  assert.equal(result.session_id, "thread-123");
  assert.equal(result.status, "in_review");
  assert.equal(
    result.pr_url,
    "https://github.com/farshidz/marqo-cortex-city/pull/456"
  );
});

test("dead task-lock recovery cannot unlink a replacement owner", async () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  writeFileSync(
    path.join(cortexDir, "tasks.json"),
    JSON.stringify([sampleTask()], null, 2)
  );

  const deadOwnerHeld = path.join(workspace, "dead-owner-held");
  const recoveryObserved = path.join(workspace, "recovery-observed");
  const contenderAEntered = path.join(workspace, "contender-a-entered");
  const contenderBEntered = path.join(workspace, "contender-b-entered");
  const releaseContenderB = path.join(workspace, "release-contender-b");
  const children: ReturnType<typeof spawn>[] = [];
  const stderr = new Map<ReturnType<typeof spawn>, string>();

  const spawnStoreScript = (body: string, args: string[] = []) => {
    const child = spawn(
      TSX_BIN,
      [
        "--eval",
        [
          "(async () => {",
          body,
          "})().catch((error) => {",
          "  console.error(error);",
          "  process.exit(1);",
          "});",
        ].join("\n"),
        ...args,
      ],
      { cwd: workspace, stdio: ["ignore", "ignore", "pipe"] }
    );
    children.push(child);
    stderr.set(child, "");
    child.stderr?.on("data", (chunk) => {
      stderr.set(child, `${stderr.get(child)}${chunk.toString()}`);
    });
    return child;
  };

  const waitForPath = async (target: string, child?: ReturnType<typeof spawn>) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (existsSync(target)) return;
      if (child && (child.exitCode !== null || child.signalCode !== null)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${path.basename(target)}${
        child ? `: ${stderr.get(child)}` : ""
      }`
    );
  };

  const waitForExit = (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(child.exitCode);
    }
    return new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  };

  const importStore = [
    `const importedStore = await import(${JSON.stringify(STORE_MODULE_URL)});`,
    "const store = importedStore.default || importedStore;",
  ].join("\n");

  let contenderA;
  let contenderB;
  try {
    const deadOwner = spawnStoreScript(
      [
        'const fs = require("node:fs");',
        importStore,
        'await store.updateTaskAtomically("task-1", () => {',
        '  fs.writeFileSync(process.argv[1], "held");',
        '  process.kill(process.pid, "SIGKILL");',
        "});",
      ].join("\n"),
      [deadOwnerHeld]
    );
    await waitForPath(deadOwnerHeld, deadOwner);
    await waitForExit(deadOwner);

    contenderA = spawnStoreScript(
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const realUnlinkSync = fs.unlinkSync.bind(fs);',
        'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
        'let delayedRecovery = false;',
        'fs.unlinkSync = (target, ...args) => {',
        '  if (!delayedRecovery && path.basename(String(target)).startsWith(".tasks.write.lock")) {',
        '    delayedRecovery = true;',
        '    fs.writeFileSync(process.argv[1], "observed");',
        '    while (!fs.existsSync(process.argv[2])) {',
        '      Atomics.wait(waitArray, 0, 0, 10);',
        '    }',
        '  }',
        '  return realUnlinkSync(target, ...args);',
        '};',
        importStore,
        'await store.updateTaskAtomically("task-1", () => {',
        '  fs.writeFileSync(process.argv[3], "entered");',
        '  return { session_id: "session-a" };',
        '});',
      ].join("\n"),
      [recoveryObserved, contenderBEntered, contenderAEntered]
    );
    await waitForPath(recoveryObserved, contenderA);

    contenderB = spawnStoreScript(
      [
        'const fs = require("node:fs");',
        importStore,
        'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
        'await store.updateTaskAtomically("task-1", () => {',
        '  fs.writeFileSync(process.argv[1], "entered");',
        '  while (!fs.existsSync(process.argv[2])) {',
        '    Atomics.wait(waitArray, 0, 0, 10);',
        '  }',
        '  return { pr_url: "https://github.com/acme/widget/pull/2" };',
        '});',
      ].join("\n"),
      [contenderBEntered, releaseContenderB]
    );
    await waitForPath(contenderBEntered, contenderB);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const overlappedReplacementOwner = existsSync(contenderAEntered);

    writeFileSync(releaseContenderB, "release");
    const [contenderAExit, contenderBExit] = await Promise.all([
      waitForExit(contenderA),
      waitForExit(contenderB),
    ]);

    assert.equal(contenderAExit, 0, stderr.get(contenderA));
    assert.equal(contenderBExit, 0, stderr.get(contenderB));
    assert.equal(overlappedReplacementOwner, false);
    const [stored] = JSON.parse(
      readFileSync(path.join(cortexDir, "tasks.json"), "utf-8")
    );
    assert.equal(stored.session_id, "session-a");
    assert.equal(stored.pr_url, "https://github.com/acme/widget/pull/2");
    assert.deepEqual(
      readdirSync(cortexDir).filter((name) =>
        name.startsWith(".tasks.write.lock.")
      ),
      []
    );
  } finally {
    if (!existsSync(releaseContenderB)) {
      writeFileSync(releaseContenderB, "release");
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
});

test("task-lock recovery rejects a reused live PID", async () => {
  const workspace = createTempWorkspace();
  const cortexDir = path.join(workspace, ".cortex");
  mkdirSync(cortexDir, { recursive: true });
  writeFileSync(
    path.join(cortexDir, "tasks.json"),
    JSON.stringify([sampleTask()], null, 2)
  );

  const livePidPath = path.join(workspace, "live-pid");
  const releaseLiveProcess = path.join(workspace, "release-live-process");
  let helperStderr = "";
  const liveProcess = spawn(
    process.execPath,
    [
      "--eval",
      [
        'const fs = require("node:fs");',
        'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
        'fs.writeFileSync(process.argv[1], String(process.pid));',
        'while (!fs.existsSync(process.argv[2])) {',
        '  Atomics.wait(waitArray, 0, 0, 10);',
        '}',
      ].join("\n"),
      livePidPath,
      releaseLiveProcess,
    ],
    { cwd: workspace, stdio: ["ignore", "ignore", "pipe"] }
  );
  liveProcess.stderr?.on("data", (chunk) => {
    helperStderr += chunk.toString();
  });

  const waitForExit = () => {
    if (liveProcess.exitCode !== null || liveProcess.signalCode !== null) {
      return Promise.resolve(liveProcess.exitCode);
    }
    return new Promise<number | null>((resolve, reject) => {
      liveProcess.once("error", reject);
      liveProcess.once("exit", resolve);
    });
  };

  try {
    for (let attempt = 0; attempt < 500 && !existsSync(livePidPath); attempt++) {
      if (liveProcess.exitCode !== null || liveProcess.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(livePidPath), true, helperStderr);
    const livePid = Number(readFileSync(livePidPath, "utf-8"));
    assert.equal(Number.isSafeInteger(livePid), true);

    const staleRecord = path.join(
      cortexDir,
      [
        ".tasks.write.lock.ticket.1",
        livePid,
        "0".repeat(64),
        "00000000-0000-4000-8000-000000000000",
      ].join(".")
    );
    writeFileSync(staleRecord, "");

    const updated = runStoreScript(
      workspace,
      `
        const updated = await store.updateTask("task-1", {
          session_id: "new-process-instance",
        });
        console.log(JSON.stringify(updated));
      `,
      5000
    );

    assert.equal(liveProcess.exitCode, null);
    assert.equal(updated.session_id, "new-process-instance");
    assert.equal(existsSync(staleRecord), false);
  } finally {
    writeFileSync(releaseLiveProcess, "release");
    const exitCode = await waitForExit();
    assert.equal(exitCode, 0, helperStderr);
  }
});

test("readTasks clears legacy reviewer state without disturbing builder review state", () => {
  const workspace = createTempWorkspace();
  const legacyReviewerTask = {
    ...sampleTask({
      id: "legacy-reviewer",
      status: "in_review",
      session_id: "builder-session-kept",
      last_review_gh_state: "builder-feedback-hash-kept",
    }),
    reviewer_session_id: "obsolete-reviewer-session",
    reviewer_run_pending: true,
    reviewer_last_reviewed_head_sha: "obsolete-reviewed-head",
    reviewer_codex_usage_session_id: "obsolete-usage-session",
    reviewer_codex_cumulative_input_tokens: 101,
    reviewer_codex_cumulative_cached_input_tokens: 202,
    reviewer_codex_cumulative_output_tokens: 303,
    resume_requested: true,
    resume_run_mode: "reviewer",
  };
  const builderReviewTask = {
    ...sampleTask({
      id: "builder-review",
      status: "in_review",
      session_id: "builder-review-session",
      current_run_pid: 4242,
      current_run_mode: "review",
      resume_requested: true,
      resume_run_mode: "review",
      codex_usage_session_id: "builder-usage-session",
      codex_cumulative_input_tokens: 11,
      codex_cumulative_cached_input_tokens: 22,
      codex_cumulative_output_tokens: 33,
      last_review_gh_state: "builder-review-feedback-hash",
    }),
    reviewer_session_id: "obsolete-reviewer-session-2",
    reviewer_run_pending: true,
    reviewer_last_reviewed_head_sha: "obsolete-reviewed-head-2",
    reviewer_codex_usage_session_id: "obsolete-usage-session-2",
    reviewer_codex_cumulative_input_tokens: 404,
    reviewer_codex_cumulative_cached_input_tokens: 505,
    reviewer_codex_cumulative_output_tokens: 606,
  };

  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "tasks.json"),
    JSON.stringify([legacyReviewerTask, builderReviewTask], null, 2)
  );

  const result = runStoreScript(
    workspace,
    `
      const normalized = store.readTasks();
      await store.writeTasks(normalized);
      const persisted = JSON.parse(
        require("node:fs").readFileSync(
          require("node:path").join(process.cwd(), ".cortex", "tasks.json"),
          "utf-8"
        )
      );
      console.log(JSON.stringify({ normalized, persisted }));
    `
  );

  assert.deepEqual(result.persisted, result.normalized);
  const obsoleteFields = [
    "reviewer_session_id",
    "reviewer_run_pending",
    "reviewer_last_reviewed_head_sha",
    "reviewer_codex_usage_session_id",
    "reviewer_codex_cumulative_input_tokens",
    "reviewer_codex_cumulative_cached_input_tokens",
    "reviewer_codex_cumulative_output_tokens",
  ];
  for (const task of result.normalized) {
    for (const field of obsoleteFields) {
      assert.equal(Object.hasOwn(task, field), false, `${field} should be removed`);
    }
  }

  const legacy = result.normalized.find(
    (task: Task) => task.id === "legacy-reviewer"
  );
  assert.equal(legacy.session_id, "builder-session-kept");
  assert.equal(legacy.last_review_gh_state, "builder-feedback-hash-kept");
  assert.equal(legacy.review_migration_head_sha, "obsolete-reviewed-head");
  assert.equal(Object.hasOwn(legacy, "resume_requested"), false);
  assert.equal(Object.hasOwn(legacy, "resume_run_mode"), false);

  const builder = result.normalized.find(
    (task: Task) => task.id === "builder-review"
  );
  assert.equal(builder.session_id, "builder-review-session");
  assert.equal(builder.current_run_pid, 4242);
  assert.equal(builder.current_run_mode, "review");
  assert.equal(builder.resume_requested, true);
  assert.equal(builder.resume_run_mode, "review");
  assert.equal(builder.codex_usage_session_id, "builder-usage-session");
  assert.equal(builder.codex_cumulative_input_tokens, 11);
  assert.equal(builder.codex_cumulative_cached_input_tokens, 22);
  assert.equal(builder.codex_cumulative_output_tokens, 33);
  assert.equal(builder.last_review_gh_state, "builder-review-feedback-hash");
  assert.equal(
    builder.review_migration_head_sha,
    "obsolete-reviewed-head-2"
  );
});

test("readTasks restores from last-good backup when tasks file is corrupt", () => {
  const workspace = createTempWorkspace();
  const task = sampleTask();

  const result = runStoreScript(
    workspace,
    `
      const fs = await import("node:fs");
      const path = await import("node:path");
      await store.createTask(${JSON.stringify(task)});
      const tasksFile = path.join(process.cwd(), ".cortex", "tasks.json");
      const backupFile = path.join(
        process.cwd(),
        ".cortex",
        "backups",
        "tasks.json.last-good"
      );
      const backupBefore = fs.readFileSync(backupFile, "utf-8");
      fs.writeFileSync(tasksFile, backupBefore.slice(0, 20));
      const recovered = store.readTasks();
      console.log(JSON.stringify({
        recovered,
        restored: fs.readFileSync(tasksFile, "utf-8") === backupBefore,
      }));
    `
  );

  assert.deepEqual(result.recovered, [task]);
  assert.equal(result.restored, true);
});

test("writeConfig persists the supplied configuration", () => {
  const workspace = createTempWorkspace();
  const config: OrchestratorConfig = {
    max_parallel_sessions: 5,
    poll_interval_seconds: 10,
    task_run_timeout_ms: 300000,
    default_permission_mode: "yolo",
    default_agent_runner: "codex",
    review_learning_enabled: true,
    agents: {
      "cortex-city-swe": {
        name: "Cortex City SWE",
        repo_slug: "farshidz/marqo-cortex-city",
        repo_path: "/tmp/repo",
        prompt_file: "prompts/agents/cortex-city-swe.md",
        review_prompt_file: "prompts/agents/cortex-city-swe.review.md",
        cleanup_prompt_file: "prompts/agents/cortex-city-swe.cleanup.md",
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
    task_run_timeout_ms: 120000,
    default_permission_mode: "default",
    default_agent_runner: "claude",
    review_learning_enabled: true,
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

test("updateTask syncs the linked issue status", () => {
  const workspace = createTempWorkspace();
  const result = runStoreScript(
    workspace,
    `
      const imported = await import(${JSON.stringify(
        pathToFileURL(path.join(REPO_ROOT, "src/lib/issue-store.ts")).href
      )});
      const issueStore = imported.default || imported;
      const issue = await issueStore.createIssue({ title: "Issue", description: "" });
      await issueStore.linkTask(issue.id, "task-1");
      const task = ${JSON.stringify(sampleTask({ issue_id: "PLACEHOLDER" }))};
      task.issue_id = issue.id;
      await store.createTask(task);
      await store.updateTask("task-1", { status: "merged" });
      console.log(JSON.stringify(issueStore.readIssues()[0]));
    `
  );

  assert.equal(result.status, "done");
  assert.equal(result.task_id, "task-1");
});

test("deleteTask removes only the deleted task session logs", () => {
  const workspace = createTempWorkspace();
  mkdirSync(path.join(workspace, "logs"), { recursive: true });
  writeFileSync(path.join(workspace, "logs", "task-task-1-run.log"), "log");
  writeFileSync(path.join(workspace, "logs", "task-task-1-run.jsonl"), "machine");
  writeFileSync(path.join(workspace, "logs", "task-task-2-run.log"), "keep");
  writeFileSync(path.join(workspace, "logs", "server-2026-04-15.log"), "server");

  const result = runStoreScript(
    workspace,
    `
      await store.createTask(${JSON.stringify(sampleTask())});
      await store.deleteTask("task-1");
      console.log(JSON.stringify({
        deletedLogExists: require("node:fs").existsSync(${JSON.stringify(
          path.join(workspace, "logs", "task-task-1-run.log")
        )}),
        deletedJsonExists: require("node:fs").existsSync(${JSON.stringify(
          path.join(workspace, "logs", "task-task-1-run.jsonl")
        )}),
        otherLogExists: require("node:fs").existsSync(${JSON.stringify(
          path.join(workspace, "logs", "task-task-2-run.log")
        )}),
        serverLogExists: require("node:fs").existsSync(${JSON.stringify(
          path.join(workspace, "logs", "server-2026-04-15.log")
        )}),
      }));
    `
  );

  assert.equal(result.deletedLogExists, false);
  assert.equal(result.deletedJsonExists, false);
  assert.equal(result.otherLogExists, true);
  assert.equal(result.serverLogExists, true);
  assert.equal(existsSync(path.join(workspace, "logs", "task-task-2-run.log")), true);
});
