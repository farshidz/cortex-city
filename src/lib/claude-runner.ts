import { spawn, execSync, type ChildProcess } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { readConfig, updateTask } from "./store";
import { buildInitialPrompt, buildReviewPrompt, buildCleanupPrompt } from "./prompt-builder";
import { getPRStateHash, getSubmittedCommentIds } from "./github";
import { createSessionLog } from "./logger";
import type { Task, AgentReport, ClaudeRunResult } from "./types";

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
  required: ["status", "summary", "files_changed", "assumptions", "blockers", "next_steps"],
});

export async function spawnClaudeSession(
  task: Task,
  mode: "initial" | "review" | "cleanup",
  onComplete: (taskId: string) => void
): Promise<{ pid: number; child: ChildProcess }> {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];

  // Build prompt based on mode
  let prompt: string;
  if (mode === "initial") {
    prompt = buildInitialPrompt(task);
  } else if (mode === "review") {
    prompt = buildReviewPrompt(task);
  } else {
    prompt = buildCleanupPrompt(task);
  }

  // Build CLI args
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    AGENT_REPORT_SCHEMA,
    "--permission-mode",
    config.permission_mode,
  ];

  // For follow-ups, use --continue to resume the most recent session in this
  // worktree directory. Each task has its own worktree so there's no ambiguity.
  // --session-id and --resume both error with "already in use" for completed
  // sessions, but --continue resolves by directory and works reliably.
  if (mode === "review" && task.session_id) {
    args.push("--continue");
  }

  const repoPath = agentConfig?.repo_path || process.cwd();

  // Create or reuse a git worktree for isolation
  const cwd = ensureWorktree(task, repoPath, agentConfig?.default_branch || "main");

  console.log(
    `[claude-runner] Spawning session for task "${task.title}" (${task.id}) in worktree ${cwd}`
  );

  // Capture submitted comment IDs before the run to detect mid-run additions
  const preRunCommentIds = task.pr_url
    ? await getSubmittedCommentIds(task.pr_url)
    : [];

  // Stream session output to disk in real-time
  const sessionLog = createSessionLog(task.id);
  console.log(`[claude-runner] Session log: ${sessionLog.path}`);

  const spawnedAt = Date.now();

  const child = spawn("claude", args, {
    cwd,
    env: buildEnv(agentConfig?.env_file),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    sessionLog.stdout.write(text);
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
      `[claude-runner] Session for task "${task.title}" exited with code ${code} (${Math.round(durationMs / 1000)}s)`
    );
    await handleRunComplete(task.id, code, stdout, stderr, durationMs, preRunCommentIds);
    onComplete(task.id);
  });

  child.on("error", async (err) => {
    sessionLog.stdout.end();
    sessionLog.stderr.end();
    console.error(
      `[claude-runner] Failed to spawn for task "${task.title}":`,
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
    console.log(`[claude-runner] Reusing existing worktree at ${task.worktree_path}`);
    return task.worktree_path;
  }

  // Fetch latest from remote before creating worktree
  try {
    execSync(`git fetch origin ${defaultBranch}`, { cwd: repoPath, stdio: "pipe" });
  } catch (err) {
    console.error(`[claude-runner] git fetch failed:`, err);
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
      console.log(`[claude-runner] Found worktree directory at ${worktreePath}`);
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

    console.log(`[claude-runner] Created worktree at ${worktreePath} (branch: ${branchName})`);
  } catch (err) {
    console.error(`[claude-runner] Failed to create worktree:`, err);
    // Fall back to the main repo path
    return repoPath;
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
    console.log(`[claude-runner] Removed worktree at ${task.worktree_path}`);
  } catch (err) {
    console.error(`[claude-runner] Failed to remove worktree at ${task.worktree_path}:`, err);
  }
}

async function handleRunComplete(
  taskId: string,
  exitCode: number | null,
  stdout: string,
  _stderr: string,
  durationMs: number,
  preRunCommentIds: number[]
) {
  try {
    const result: ClaudeRunResult = JSON.parse(stdout);

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
    if (currentTask) {
      updates.total_input_tokens =
        (currentTask.total_input_tokens || 0) + inputTokens;
      updates.total_output_tokens =
        (currentTask.total_output_tokens || 0) + outputTokens;
      updates.total_duration_ms =
        (currentTask.total_duration_ms || 0) + durationMs;
      updates.run_count = (currentTask.run_count || 0) + 1;
    }

    // Capture GH state hash AFTER run so we don't re-trigger on our own changes
    // But if new submitted comments appeared mid-run, skip hash update so next poll picks them up
    const prUrl = updates.pr_url || currentTask?.pr_url;
    if (prUrl) {
      const postRunCommentIds = await getSubmittedCommentIds(prUrl);
      const newComments = postRunCommentIds.filter((id) => !preRunCommentIds.includes(id));
      if (newComments.length > 0) {
        console.log(
          `[claude-runner] ${newComments.length} new comment(s) added during run for task ${taskId} — skipping hash update`
        );
      } else {
        const newHash = await getPRStateHash(prUrl);
        if (newHash) {
          updates.last_review_gh_state = newHash;
        }
      }
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
