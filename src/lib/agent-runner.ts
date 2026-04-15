import { spawn, execSync, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from "fs";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { readConfig, updateTask, createTask } from "./store";
import {
  buildInitialPrompt,
  buildReviewPrompt,
  buildCleanupPrompt,
  buildContinuePrompt,
  buildManualInstructionPrompt,
} from "./prompt-builder";
import { getPRStateHash, getSubmittedCommentIds } from "./github";
import { createSessionLog } from "./logger";
import type {
  Task,
  AgentReport,
  ClaudeRunResult,
  AgentRuntime,
  PermissionMode,
  FollowupTaskRequest,
} from "./types";
import { resolveEnvPath } from "./agent-files";

const GLOBAL_ENV_FILE = path.join(process.cwd(), ".env");

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // File doesn't exist or can't be read — that's fine
  }
  return vars;
}

function buildEnv(agentEnvFile?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Load global .env first
  Object.assign(env, loadEnvFile(GLOBAL_ENV_FILE));
  // Then agent-specific .env (overrides global)
  if (agentEnvFile) {
    const envPath = path.isAbsolute(agentEnvFile)
      ? agentEnvFile
      : path.join(process.cwd(), agentEnvFile);
    Object.assign(env, loadEnvFile(envPath));
  }
  return env;
}

const AGENT_REPORT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["completed", "needs_review", "blocked", "failed"],
      description: "Overall outcome of this run",
    },
    summary: {
      type: "string",
      description: "Brief summary of what was done or what went wrong",
    },
    pr_url: {
      type: "string",
      description: "Full GitHub pull request URL if one was created or already exists",
    },
    branch_name: {
      type: "string",
      description: "Git branch name used for this work",
    },
    files_changed: {
      type: "array",
      items: { type: "string" },
      description: "List of files that were created or modified",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Decisions made without explicit guidance — document any ambiguity you resolved on your own",
    },
    blockers: {
      type: "array",
      items: { type: "string" },
      description: "Issues that prevented completion — missing context, failing dependencies, unclear requirements, etc.",
    },
    next_steps: {
      type: "array",
      items: { type: "string" },
      description: "Recommended follow-up actions for the task owner",
    },
  },
  patternProperties: {
    "^tool_calls$": {
      type: "object",
      description:
        "Optional tool invocations to request operator actions (only specify tools actually used)",
      properties: {
        create_task: {
          type: "array",
          description:
            "List of follow-up tasks to create via the agent orchestrator (use sparingly)",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short task title" },
              description: { type: "string", description: "Detailed task description" },
              agent: {
                type: "string",
                description: "Agent ID (from settings) that should own this task",
              },
            },
            patternProperties: {
              "^plan$": {
                type: "string",
                description: "Optional execution plan or checklist",
              },
            },
            required: ["title", "description", "agent"],
            additionalProperties: false,
          },
        },
      },
      required: ["create_task"],
      additionalProperties: false,
    },
  },
  required: [
    "status",
    "summary",
    "pr_url",
    "branch_name",
    "files_changed",
    "assumptions",
    "blockers",
    "next_steps"
  ],
  additionalProperties: false,
});

function buildPermissionArgs(runtime: AgentRuntime, mode: PermissionMode): string[] {
  if (runtime === "codex") {
    if (mode === "yolo" || mode === "bypassPermissions") {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    return ["--full-auto"];
  }
  if (mode === "yolo") {
    return ["--permission-mode", "bypassPermissions"];
  }
  return ["--permission-mode", mode];
}

function writeSchemaFile(schema: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-schema-"));
  const schemaPath = path.join(dir, "schema.json");
  writeFileSync(schemaPath, schema, "utf-8");
  return schemaPath;
}

export async function spawnAgentSession(
  task: Task,
  mode: "initial" | "review" | "cleanup",
  onComplete: (taskId: string) => void
): Promise<{ pid: number; child: ChildProcess }> {
  const config = readConfig();
  const runtime: AgentRuntime =
    task.agent_runner || config.default_agent_runner || "claude";
  const permissionMode: PermissionMode =
    task.permission_mode || config.default_permission_mode || "bypassPermissions";
  const agentConfig = config.agents[task.agent];
  const shouldResume = Boolean(task.session_id);
  const hasManualInstruction = Boolean(task.pending_manual_instruction?.trim());
  const isResumeAfterKill = Boolean(task.resume_requested);
  const runReason =
    mode === "cleanup"
      ? "cleanup"
      : hasManualInstruction
        ? "manual_instruction"
        : isResumeAfterKill
          ? "resume_after_kill"
          : mode === "review"
            ? "review"
            : "initial";

  // Build prompt based on mode
  let prompt: string;
  let promptMode: "initial" | "review" | "cleanup" | "manual" | "resume";
  if (hasManualInstruction) {
    prompt = buildManualInstructionPrompt(task);
    promptMode = "manual";
  } else if (isResumeAfterKill) {
    prompt = buildContinuePrompt();
    promptMode = "resume";
  } else if (mode === "initial") {
    prompt = buildInitialPrompt(task);
    promptMode = "initial";
  } else if (mode === "review") {
    prompt = buildReviewPrompt(task, {
      prStatus: task.pr_status,
      baseBranch: agentConfig?.default_branch || "main",
    });
    promptMode = "review";
  } else {
    prompt = buildCleanupPrompt(task);
    promptMode = "cleanup";
  }

  // Build CLI args
  const args: string[] = [];
  if (runtime === "codex") {
    if (shouldResume) {
      args.push("exec", "resume", "--json");
    } else {
      args.push("exec", "--json");
      const schemaPath = writeSchemaFile(AGENT_REPORT_SCHEMA);
      args.push("--output-schema", schemaPath);
    }
  } else {
    args.push(
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      AGENT_REPORT_SCHEMA
    );
  }
  args.push(...buildPermissionArgs(runtime, permissionMode));

  if (runtime === "codex") {
    if (shouldResume && task.session_id) {
      args.push(task.session_id);
    }
    args.push(prompt);
  }

  if (runtime !== "codex" && shouldResume && task.session_id) {
    args.push("--resume", task.session_id);
  }

  const repoPath = agentConfig?.repo_path || process.cwd();

  // Create or reuse a git worktree for isolation
  const cwd = ensureWorktree(task, repoPath, agentConfig?.default_branch || "main");

  const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
  console.log(
    `[agent-runner] Spawning ${runtimeLabel} session for task "${task.title}" (${task.id}) in worktree ${cwd}`
  );

  // Capture submitted comment IDs before the run to detect mid-run additions
  const preRunCommentIds = task.pr_url
    ? await getSubmittedCommentIds(task.pr_url)
    : [];

  // Stream session output to disk in real-time
  const sessionLog = createSessionLog(task.id);
  console.log(`[agent-runner] Session log: ${sessionLog.path}`);

  if (runtime === "codex") {
    sessionLog.stdout.write(
      `${JSON.stringify({
        type: "prompt",
        mode: promptMode,
        timestamp: new Date().toISOString(),
        content: prompt,
      })}\n`
    );
  }

  const spawnedAt = Date.now();

  const envFile = resolveEnvPath(agentConfig, task.agent);
  const child = spawn(runtime === "codex" ? "codex" : "claude", args, {
    cwd,
    env: buildEnv(envFile),
    stdio: ["pipe", "pipe", "pipe"],
  });

  // We pass prompts via args, so leaving stdin open only creates delays or hangs.
  child.stdin?.end();

  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  let capturedSessionId = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    sessionLog.stdout.write(text);

    // Capture Codex session/thread ID as soon as it appears so the UI can show
    // live session data while the run is still active.
    if (runtime === "codex" && !capturedSessionId) {
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            thread_id?: string;
          };
          if (evt.type === "thread.started" && evt.thread_id) {
            capturedSessionId = true;
            void updateTask(task.id, { session_id: evt.thread_id });
            break;
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    sessionLog.stderr.write(text);
  });

  child.on("close", async (code) => {
    sessionLog.stdout.end();
    sessionLog.stderr.end();
    const durationMs = Date.now() - spawnedAt;
    console.log(
      `[agent-runner] Session for task "${task.title}" exited with code ${code} (${Math.round(durationMs / 1000)}s)`
    );
    await handleRunComplete(
      task.id,
      code,
      stdout,
      stderr,
      durationMs,
      preRunCommentIds,
      runtime,
      runReason
    );
    onComplete(task.id);
  });

  child.on("error", async (err) => {
    sessionLog.stdout.end();
    sessionLog.stderr.end();
    console.error(
      `[agent-runner] Failed to spawn for task "${task.title}":`,
      err
    );
    await updateTask(task.id, {
      last_run_result: "error",
      error_log: err.message,
      current_run_pid: undefined,
    });
    onComplete(task.id);
  });

  return { pid: child.pid!, child };
}

function slugify(title: string, maxLen: number): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

function ensureWorktree(task: Task, repoPath: string, defaultBranch: string): string {
  // Reuse existing worktree if it still exists on disk
  if (task.worktree_path && existsSync(task.worktree_path)) {
    console.log(`[agent-runner] Reusing existing worktree at ${task.worktree_path}`);
    return task.worktree_path;
  }

  // Fetch latest from remote before creating worktree
  try {
    execSync(`git fetch origin ${defaultBranch}`, { cwd: repoPath, stdio: "pipe" });
  } catch (err) {
    console.error(`[agent-runner] git fetch failed:`, err);
  }

  // Worktrees live in a sibling directory: <repo>/../.worktrees/<slug>
  const worktreesBase = path.join(repoPath, "..", ".worktrees");
  if (!existsSync(worktreesBase)) {
    mkdirSync(worktreesBase, { recursive: true });
  }

  // Build a short, readable slug from the task title (max 20 chars total)
  const slug = slugify(task.title, 20) || task.id.slice(0, 10);
  const worktreePath = path.join(worktreesBase, slug);

  // Branch name: agent/<slug> (max 20 chars for the slug part)
  const branchName = task.branch_name || `agent/${slug}`;

  try {
    if (existsSync(worktreePath)) {
      // Worktree directory exists but wasn't tracked — reuse it and persist
      console.log(`[agent-runner] Found worktree directory at ${worktreePath}`);
      if (!task.worktree_path) {
        updateTask(task.id, { worktree_path: worktreePath, branch_name: branchName });
      }
      return worktreePath;
    }

    // Try to create worktree on existing branch first, fall back to new branch
    try {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: repoPath,
        stdio: "pipe",
      });
    } catch {
      // Branch doesn't exist yet — create from latest remote default branch
      execSync(
        `git worktree add -b "${branchName}" "${worktreePath}" "origin/${defaultBranch}"`,
        { cwd: repoPath, stdio: "pipe" }
      );
    }

    console.log(`[agent-runner] Created worktree at ${worktreePath} (branch: ${branchName})`);
  } catch (err) {
    console.error(`[agent-runner] Failed to create worktree:`, err);
    throw err instanceof Error
      ? err
      : new Error("Failed to create worktree");
  }

  // Persist worktree path and branch name to task
  updateTask(task.id, { worktree_path: worktreePath, branch_name: branchName });

  return worktreePath;
}

export function removeWorktree(task: Task): void {
  if (!task.worktree_path) return;

  const agentConfig = readConfig().agents[task.agent];
  const repoPath = agentConfig?.repo_path;
  if (!repoPath) return;

  try {
    execSync(`git worktree remove "${task.worktree_path}" --force`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    console.log(`[agent-runner] Removed worktree at ${task.worktree_path}`);
  } catch (err) {
    console.error(`[agent-runner] Failed to remove worktree at ${task.worktree_path}:`, err);
  }
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

function parseCodexResult(stdout: string): ClaudeRunResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as CodexEvent[];
  const threadEvent = events.find((evt) => evt.type === "thread.started");
  const agentMessages = events.filter(
    (evt) => evt.type === "item.completed" && evt.item?.type === "agent_message"
  );
  const finalMessage = agentMessages[agentMessages.length - 1];
  let structured: AgentReport | undefined;
  const resultText = finalMessage?.item?.text || "";
  if (resultText) {
    try {
      structured = JSON.parse(resultText);
    } catch {
      structured = undefined;
    }
  }
  const usageEvent = events.find((evt) => evt.type === "turn.completed");
  const usage = usageEvent?.usage || {};
  return {
    type: "codex",
    subtype: "exec",
    is_error: false,
    duration_ms: 0,
    result: resultText || stdout,
    session_id: threadEvent?.thread_id || "",
    terminal_reason: "completed",
    total_cost_usd: 0,
    num_turns: 1,
    structured_output: structured,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cached_input_tokens || 0,
    },
  };
}

async function createFollowupTasks(
  parentTask: Task,
  requests: FollowupTaskRequest[]
): Promise<void> {
  if (!requests || requests.length === 0) return;
  const config = readConfig();
  const inheritedRunner = parentTask.agent_runner || config.default_agent_runner;
  const inheritedPermission =
    parentTask.permission_mode || config.default_permission_mode;
  for (const req of requests) {
    const title = (req.title || "").trim();
    const description = (req.description || "").trim();
    const agentId = (req.agent || parentTask.agent || "").trim();
    if (!title || !description || !agentId) {
      console.warn(
        `[agent-runner] Skipping follow-up task with missing data (title="${req.title}", agent="${req.agent}")`
      );
      continue;
    }

    const now = new Date().toISOString();
    const newTask: Task = {
      id: nanoid(10),
      title,
      description,
      plan: req.plan?.trim() || undefined,
      status: "open",
      agent: agentId,
      agent_runner: inheritedRunner,
      permission_mode: inheritedPermission,
      parent_task_id: parentTask.id,
      created_at: now,
      updated_at: now,
    };

    await createTask(newTask);
    console.log(
      `[agent-runner] Created follow-up task "${title}" (${newTask.id}) from parent task ${parentTask.id}`
    );
  }
}

async function handleRunComplete(
  taskId: string,
  exitCode: number | null,
  stdout: string,
  _stderr: string,
  durationMs: number,
  preRunCommentIds: number[],
  runtime: AgentRuntime,
  runReason: "initial" | "review" | "cleanup" | "manual_instruction" | "resume_after_kill"
) {
  try {
    const result: ClaudeRunResult =
      runtime === "codex" ? parseCodexResult(stdout) : JSON.parse(stdout);

    const inputTokens = (result.usage?.input_tokens || 0) + (result.usage?.cache_read_input_tokens || 0);
    const outputTokens = result.usage?.output_tokens || 0;

    const updates: Partial<Task> = {
      session_id: result.session_id,
      last_run_result: result.is_error ? "error" : "success",
      last_run_input_tokens: inputTokens,
      last_run_output_tokens: outputTokens,
      current_run_pid: undefined,
      last_run_at: new Date().toISOString(),
    };

    if (result.terminal_reason === "budget_exceeded") {
      updates.last_run_result = "budget_exceeded";
    }

    // Parse structured agent report
    const report: AgentReport | undefined = result.structured_output;
    if (report) {
      updates.last_agent_report = report;

      // Use structured fields for PR URL and branch
      if (report.pr_url) {
        updates.pr_url = report.pr_url;
      }
      if (report.branch_name) {
        updates.branch_name = report.branch_name;
      }

      // Auto-transition status based on agent report
      if (report.status === "completed" || report.status === "needs_review") {
        if (report.pr_url) {
          updates.status = "in_review";
        }
      }
    } else {
      // Fallback: regex-match PR URL from plain text result
      const prMatch = result.result?.match(
        /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/
      );
      if (prMatch) {
        updates.pr_url = prMatch[0];
        updates.status = "in_review";
      }
    }

    // Accumulate costs and run count
    const { getTask } = await import("./store");
    const currentTask = await getTask(taskId);
    if (!updates.session_id && currentTask?.session_id) {
      updates.session_id = currentTask.session_id;
    }
    if (currentTask) {
      updates.total_input_tokens =
        (currentTask.total_input_tokens || 0) + inputTokens;
      updates.total_output_tokens =
        (currentTask.total_output_tokens || 0) + outputTokens;
      updates.total_duration_ms =
        (currentTask.total_duration_ms || 0) + durationMs;
      updates.run_count = (currentTask.run_count || 0) + 1;

      const followups = report?.tool_calls?.create_task;
      if (followups?.length) {
        await createFollowupTasks(currentTask, followups);
      }
    }

    // Capture GH state hash AFTER run so we don't re-trigger on our own changes
    // But if new submitted comments appeared mid-run, skip hash update so next poll picks them up
    const prUrl = updates.pr_url || currentTask?.pr_url;
    if (prUrl && runReason !== "manual_instruction") {
      const postRunCommentIds = await getSubmittedCommentIds(prUrl);
      const newComments = postRunCommentIds.filter((id) => !preRunCommentIds.includes(id));
      if (newComments.length > 0) {
        console.log(
          `[agent-runner] ${newComments.length} new comment(s) added during run for task ${taskId} — skipping hash update`
        );
      } else {
        const newHash = await getPRStateHash(prUrl);
        if (newHash) {
          updates.last_review_gh_state = newHash;
        }
      }
    } else if (prUrl) {
      console.log(
        `[agent-runner] Skipping review hash update for manual-instruction run on task ${taskId}`
      );
    }

    await updateTask(taskId, updates);
  } catch {
    await updateTask(taskId, {
      last_run_result: "error",
      error_log: `Exit code: ${exitCode}`,
      current_run_pid: undefined,
      last_run_at: new Date().toISOString(),
    });
  }
}

export const __testUtils = {
  createFollowupTasks,
  parseCodexResult,
};
