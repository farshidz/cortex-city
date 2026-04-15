import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentReport, Task } from "../lib/types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const WORKER_ENTRY = path.join(REPO_ROOT, "src", "orchestrator-worker.ts");

export interface FakeAgentRule {
  runtime?: "codex" | "claude";
  match: string;
  delay_ms?: number;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  report: AgentReport;
}

export interface IntegrationWorkspace {
  root: string;
  repoPath: string;
  behaviorFile: string;
  stdoutLog: string;
  stderrLog: string;
}

function run(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function writeTemplates(workspace: string) {
  mkdirSync(path.join(workspace, "prompts", "templates"), { recursive: true });
  mkdirSync(path.join(workspace, "prompts", "agents"), { recursive: true });

  writeFileSync(
    path.join(workspace, "prompts", "templates", "initial.md"),
    ["TASK {{TASK_TITLE}}", "{{TASK_DESCRIPTION}}", "{{TASK_PLAN}}", "{{AGENT_NAME}}"].join("\n")
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "review.md"),
    ["REVIEW {{TASK_TITLE}}", "{{PR_URL}}", "{{BASE_BRANCH}}", "{{MERGE_STATUS}}"].join("\n")
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "cleanup.md"),
    ["CLEANUP {{TASK_TITLE}}", "{{FINAL_STATUS}}", "{{AGENT_DIRECTORY}}"].join("\n")
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.md"),
    "Integration test agent prompt"
  );
}

function initGitRepo(workspace: string): string {
  const remotePath = path.join(workspace, "remote.git");
  const repoPath = path.join(workspace, "repo");
  mkdirSync(repoPath, { recursive: true });

  run("git", ["init", "--bare", remotePath], workspace);
  run("git", ["init", "-b", "main"], repoPath);
  run("git", ["config", "user.name", "Integration Test"], repoPath);
  run("git", ["config", "user.email", "integration@example.com"], repoPath);

  writeFileSync(path.join(repoPath, "README.md"), "# Integration Workspace\n");
  run("git", ["add", "README.md"], repoPath);
  run("git", ["commit", "-m", "Initial commit"], repoPath);
  run("git", ["remote", "add", "origin", remotePath], repoPath);
  run("git", ["push", "-u", "origin", "main"], repoPath);

  return repoPath;
}

function writeConfig(workspace: string, repoPath: string, maxParallelSessions: number) {
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(
      {
        max_parallel_sessions: maxParallelSessions,
        poll_interval_seconds: 1,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "codex",
        agents: {
          "cortex-city-swe": {
            name: "Cortex City SWE",
            repo_slug: "farshidz/marqo-cortex-city",
            repo_path: repoPath,
            prompt_file: "prompts/agents/cortex-city-swe.md",
            default_branch: "main",
            description: "Integration test agent",
          },
        },
      },
      null,
      2
    )
  );
}

function writeFakeCliScripts(workspace: string, behaviorFile: string) {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });

  const agentScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function getPrompt(runtime, args) {
  if (runtime === "claude") {
    const promptIndex = args.indexOf("-p");
    return promptIndex >= 0 ? args[promptIndex + 1] || "" : "";
  }
  return args[args.length - 1] || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runtime = path.basename(process.argv[1]) === "claude" ? "claude" : "codex";
  const args = process.argv.slice(2);
  const prompt = getPrompt(runtime, args);
  const rules = JSON.parse(fs.readFileSync(process.env.FAKE_AGENT_BEHAVIOR_FILE, "utf8"));
  const rule = rules.find((candidate) => {
    return (!candidate.runtime || candidate.runtime === runtime) && prompt.includes(candidate.match);
  });

  if (!rule) {
    console.error("No fake agent rule matched prompt:", prompt);
    process.exit(1);
  }

  fs.appendFileSync(
    path.join(process.cwd(), ".fake-agent-log.ndjson"),
    JSON.stringify({ runtime, prompt, args }) + "\\n"
  );

  fs.writeFileSync(
    path.join(process.cwd(), ".fake-agent-last-run.json"),
    JSON.stringify({ runtime, prompt, args }, null, 2)
  );

  if (rule.delay_ms) {
    await sleep(rule.delay_ms);
  }

  if (runtime === "claude") {
    process.stdout.write(
      JSON.stringify({
        type: "claude",
        subtype: "test",
        is_error: false,
        duration_ms: rule.delay_ms || 0,
        result: JSON.stringify(rule.report),
        session_id: rule.thread_id || "",
        terminal_reason: "completed",
        total_cost_usd: 0,
        num_turns: 1,
        structured_output: rule.report,
        usage: {
          input_tokens: rule.usage?.input_tokens || 0,
          output_tokens: rule.usage?.output_tokens || 0,
          cache_read_input_tokens: rule.usage?.cached_input_tokens || 0,
        },
      })
    );
    return;
  }

  const events = [
    { type: "thread.started", thread_id: rule.thread_id || "" },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify(rule.report),
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: rule.usage?.input_tokens || 0,
        cached_input_tokens: rule.usage?.cached_input_tokens || 0,
        output_tokens: rule.usage?.output_tokens || 0,
      },
    },
  ];

  process.stdout.write(events.map((entry) => JSON.stringify(entry)).join("\\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  const ghScript = `#!/usr/bin/env node
process.stdout.write("");
`;

  for (const name of ["codex", "claude"]) {
    const target = path.join(binDir, name);
    writeFileSync(target, agentScript);
    chmodSync(target, 0o755);
  }

  const ghTarget = path.join(binDir, "gh");
  writeFileSync(ghTarget, ghScript);
  chmodSync(ghTarget, 0o755);

  writeFileSync(behaviorFile, "[]\n");
}

export function createIntegrationWorkspace(
  prefix: string,
  options: { maxParallelSessions?: number } = {}
): IntegrationWorkspace {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoPath = initGitRepo(root);
  const behaviorFile = path.join(root, "fake-agent-behavior.json");

  writeTemplates(root);
  writeConfig(root, repoPath, options.maxParallelSessions ?? 2);
  writeFakeCliScripts(root, behaviorFile);
  writeFileSync(path.join(root, ".cortex", "tasks.json"), "[]\n");

  return {
    root,
    repoPath,
    behaviorFile,
    stdoutLog: path.join(root, "worker.stdout.log"),
    stderrLog: path.join(root, "worker.stderr.log"),
  };
}

export function removeWorkspace(workspace: IntegrationWorkspace) {
  rmSync(workspace.root, { recursive: true, force: true });
}

export function writeBehavior(workspace: IntegrationWorkspace, rules: FakeAgentRule[]) {
  writeFileSync(workspace.behaviorFile, JSON.stringify(rules, null, 2));
}

export function writeTasks(workspace: IntegrationWorkspace, tasks: Task[]) {
  writeFileSync(
    path.join(workspace.root, ".cortex", "tasks.json"),
    JSON.stringify(tasks, null, 2)
  );
}

export function readTasks(workspace: IntegrationWorkspace): Task[] {
  const tasksPath = path.join(workspace.root, ".cortex", "tasks.json");
  if (!existsSync(tasksPath)) return [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(readFileSync(tasksPath, "utf-8")) as Task[];
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
    }
  }

  return [];
}

export function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `task-${Math.random().toString(16).slice(2, 10)}`,
    title: overrides.title || "Integration task",
    description: overrides.description || "Exercise orchestrator behavior",
    status: overrides.status || "open",
    agent: overrides.agent || "cortex-city-swe",
    created_at: overrides.created_at || now,
    updated_at: overrides.updated_at || now,
    ...overrides,
  };
}

export function spawnWorker(
  workspace: IntegrationWorkspace
): ChildProcessWithoutNullStreams {
  const child = spawn(TSX_BIN, [WORKER_ENTRY], {
    cwd: workspace.root,
    env: {
      ...process.env,
      PATH: `${path.join(workspace.root, "bin")}:${process.env.PATH || ""}`,
      FAKE_AGENT_BEHAVIOR_FILE: workspace.behaviorFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    writeFileSync(workspace.stdoutLog, chunk, { flag: "a" });
  });
  child.stderr.on("data", (chunk) => {
    writeFileSync(workspace.stderrLog, chunk, { flag: "a" });
  });

  return child;
}

export async function stopWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGINT");
  });
}

export async function waitFor<T>(
  description: string,
  callback: () => T | undefined,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = callback();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}`);
}
