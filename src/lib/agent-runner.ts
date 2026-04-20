import { spawn, execFile, type ChildProcess } from "child_process";
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
import {
  getDefaultEffortForRuntime,
  getDefaultModelForRuntime,
  normalizeEffort,
  normalizeModel,
} from "./runtime-config";
import type {
  Task,
  AgentReport,
  ClaudeRunResult,
  AgentRuntime,
  PermissionMode,
  FollowupTaskRequest,
} from "./types";
import { resolveEnvPath } from "./agent-files";
import { buildInterruptedTaskUpdates, shouldUseContinuePrompt } from "./orchestrator-runtime";

const GLOBAL_ENV_FILE = path.join(/* turbopackIgnore: true */ process.cwd(), ".env");
const DEFAULT_TASK_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_GRACE_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

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
      : path.join(/* turbopackIgnore: true */ process.cwd(), agentEnvFile);
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

function buildModelArgs(
  runtime: AgentRuntime,
  task: Pick<Task, "model" | "effort">,
  config: ReturnType<typeof readConfig>
): string[] {
  const args: string[] = [];
  const model = normalizeModel(task.model, getDefaultModelForRuntime(config, runtime));
  if (model) {
    args.push("--model", model);
  }

  const effort = normalizeEffort(runtime, task.effort, config);
  if (runtime === "codex" && effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (runtime === "claude" && effort) {
    args.push("--effort", effort);
  }

  return args;
}

function writeSchemaFile(schema: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-schema-"));
  const schemaPath = path.join(dir, "schema.json");
  writeFileSync(schemaPath, schema, "utf-8");
  return schemaPath;
}

function getExecErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error || "");
  }

  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  const message = error instanceof Error ? error.message.trim() : String(error).trim();

  return [stderr, message].filter(Boolean).join("\n");
}

function execGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoPath,
        encoding: "utf-8",
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = error as Error & { stdout?: string; stderr?: string };
          wrapped.stdout = stdout || "";
          wrapped.stderr = stderr || "";
          reject(wrapped);
          return;
        }

        resolve((stdout || "").trim());
      }
    );
  });
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function isBranchCheckedOutError(error: unknown): boolean {
  return /already checked out|is already used by worktree/i.test(
    getExecErrorMessage(error)
  );
}

async function findAvailableBranchName(
  repoPath: string,
  branchName: string
): Promise<string> {
  let suffix = 2;
  while (await branchExists(repoPath, `${branchName}-${suffix}`)) {
    suffix++;
  }
  return `${branchName}-${suffix}`;
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
  const isResumeAfterKill = shouldUseContinuePrompt(task);
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
    const schemaPath = writeSchemaFile(AGENT_REPORT_SCHEMA);
    args.push("exec", "--json", "--output-schema", schemaPath);
    if (shouldResume) {
      args.push("resume");
    } else {
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
  args.push(...buildModelArgs(runtime, task, config));

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
  const cwd = await ensureWorktree(task, repoPath, agentConfig?.default_branch || "main");

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
  console.log(
    `[agent-runner] Session logs: ${sessionLog.transcriptPath} (human), ${sessionLog.machinePath} (machine)`
  );

  if (runtime === "codex") {
    const promptEvent = {
      type: "prompt",
      mode: promptMode,
      timestamp: new Date().toISOString(),
      content: prompt,
    };
    sessionLog.machine.write(`${JSON.stringify(promptEvent)}\n`);
    const transcriptEntry = formatCodexEventForTranscript(promptEvent);
    if (transcriptEntry) sessionLog.transcript.write(transcriptEntry);
  }

  const spawnedAt = Date.now();
  const runTimeoutMs = config.task_run_timeout_ms ?? DEFAULT_TASK_RUN_TIMEOUT_MS;

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
  let transcriptLineBuffer = "";
  let capturedSessionId = false;
  let didTimeout = false;
  let didFinalize = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let forceKillHandle: NodeJS.Timeout | undefined;

  const clearRunTimers = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (forceKillHandle) clearTimeout(forceKillHandle);
  };

  const finalizeRun = async (handler: () => Promise<void>) => {
    if (didFinalize) return;
    didFinalize = true;
    clearRunTimers();
    if (runtime === "codex") {
      flushCodexTranscriptBuffer("", transcriptLineBuffer, sessionLog.transcript);
    }
    sessionLog.machine.end();
    sessionLog.transcript.end();
    await handler();
    onComplete(task.id);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    sessionLog.machine.write(text);
    if (runtime === "codex") {
      transcriptLineBuffer = flushCodexTranscriptBuffer(
        text,
        transcriptLineBuffer,
        sessionLog.transcript
      );
    } else {
      sessionLog.transcript.write(text);
    }

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
    if (runtime === "codex") {
      sessionLog.transcript.write(
        `${formatTranscriptHeading("STDERR", new Date().toISOString())}\n${text}\n`
      );
    } else {
      sessionLog.transcript.write(text);
    }
  });

  // EventEmitter listeners do not await returned promises, so keep the
  // listener itself synchronous and funnel async cleanup through finalizeRun.
  child.on("close", (code) => {
    void finalizeRun(async () => {
      const durationMs = Date.now() - spawnedAt;
      console.log(
        `[agent-runner] Session for task "${task.title}" exited with code ${code} (${Math.round(durationMs / 1000)}s)`
      );
      if (didTimeout) {
        await handleRunTimeout(task.id, durationMs, runTimeoutMs);
        return;
      }
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
    });
  });

  child.on("error", (err) => {
    void finalizeRun(async () => {
      console.error(
        `[agent-runner] Failed to spawn for task "${task.title}":`,
        err
      );
      await updateTask(task.id, {
        last_run_result: "error",
        error_log: err.message,
        current_run_pid: undefined,
      });
    });
  });

  if (runTimeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      console.error(
        `[agent-runner] Session for task "${task.title}" timed out after ${runTimeoutMs}ms`
      );
      try {
        child.kill("SIGTERM");
      } catch {}
      forceKillHandle = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, FORCE_KILL_GRACE_MS);
      forceKillHandle.unref?.();
    }, runTimeoutMs);
    timeoutHandle.unref?.();
  }

  return { pid: child.pid!, child };
}

function slugify(title: string, maxLen: number): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

async function ensureWorktree(
  task: Task,
  repoPath: string,
  defaultBranch: string
): Promise<string> {
  // Reuse existing worktree if it still exists on disk
  if (task.worktree_path && existsSync(task.worktree_path)) {
    console.log(`[agent-runner] Reusing existing worktree at ${task.worktree_path}`);
    return task.worktree_path;
  }

  // Worktree tests cover branch collisions; keep the git calls async here so
  // task creation still yields to the event loop while we probe git state.
  try {
    await execGit(repoPath, ["fetch", "origin", defaultBranch]);
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
  let branchName = task.branch_name || `agent/${slug}`;

  try {
    if (existsSync(worktreePath)) {
      // Worktree directory exists but wasn't tracked — reuse it and persist
      console.log(`[agent-runner] Found worktree directory at ${worktreePath}`);
      if (!task.worktree_path) {
        await updateTask(task.id, { worktree_path: worktreePath, branch_name: branchName });
      }
      return worktreePath;
    }

    // Try to create worktree on existing branch first, fall back to new branch
    try {
      await execGit(repoPath, ["worktree", "add", worktreePath, branchName]);
    } catch (err) {
      if (!(await branchExists(repoPath, branchName))) {
        await execGit(repoPath, [
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          `origin/${defaultBranch}`,
        ]);
      } else if (isBranchCheckedOutError(err)) {
        branchName = await findAvailableBranchName(repoPath, branchName);
        await execGit(repoPath, [
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          `origin/${defaultBranch}`,
        ]);
      } else {
        throw err;
      }
    }

    console.log(`[agent-runner] Created worktree at ${worktreePath} (branch: ${branchName})`);
  } catch (err) {
    console.error(`[agent-runner] Failed to create worktree:`, err);
    throw err instanceof Error
      ? err
      : new Error("Failed to create worktree");
  }

  // Persist worktree path and branch name to task
  await updateTask(task.id, { worktree_path: worktreePath, branch_name: branchName });

  return worktreePath;
}

export async function removeWorktree(task: Task): Promise<void> {
  if (!task.worktree_path) return;

  const agentConfig = readConfig().agents[task.agent];
  const repoPath = agentConfig?.repo_path;
  if (!repoPath) return;

  try {
    await execGit(repoPath, ["worktree", "remove", task.worktree_path, "--force"]);
    console.log(`[agent-runner] Removed worktree at ${task.worktree_path}`);
  } catch (err) {
    console.error(`[agent-runner] Failed to remove worktree at ${task.worktree_path}:`, err);
  }
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  timestamp?: string;
  mode?: string;
  message?: string;
  content?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

function formatTranscriptHeading(
  label: string,
  timestamp?: string,
  extra?: string
): string {
  const parts = [label];
  if (extra) parts.push(extra);
  return `${parts.join(" ")}${timestamp ? ` [${timestamp}]` : ""}`;
}

function formatStructuredAgentMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as AgentReport;
    if (!parsed || typeof parsed !== "object" || typeof parsed.summary !== "string") {
      return text;
    }

    const lines = [`Status: ${parsed.status || "unknown"}`, `Summary: ${parsed.summary || ""}`];
    if (parsed.pr_url) lines.push(`PR: ${parsed.pr_url}`);
    if (parsed.branch_name) lines.push(`Branch: ${parsed.branch_name}`);
    if (parsed.files_changed?.length) {
      lines.push(`Files changed: ${parsed.files_changed.join(", ")}`);
    }
    if (parsed.assumptions?.length) {
      lines.push(`Assumptions: ${parsed.assumptions.join(" | ")}`);
    }
    if (parsed.blockers?.length) {
      lines.push(`Blockers: ${parsed.blockers.join(" | ")}`);
    }
    if (parsed.next_steps?.length) {
      lines.push(`Next steps: ${parsed.next_steps.join(" | ")}`);
    }
    return lines.join("\n");
  } catch {
    return text;
  }
}

function formatCodexEventForTranscript(event: CodexEvent): string | null {
  if (event.type === "prompt") {
    const modeLabel = event.mode
      ? `${event.mode.charAt(0).toUpperCase()}${event.mode.slice(1)} prompt`
      : "Prompt";
    return `${formatTranscriptHeading("USER", event.timestamp, `(${modeLabel})`)}\n${event.content || ""}\n\n`;
  }

  if (event.type === "thread.started" && event.thread_id) {
    return `${formatTranscriptHeading("SYSTEM", event.timestamp)}\nSession started: ${event.thread_id}\n\n`;
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return `${formatTranscriptHeading("CODEX", event.timestamp)}\n${formatStructuredAgentMessage(event.item.text || "")}\n\n`;
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    const body = [`$ ${event.item.command || ""}`];
    const output = event.item.aggregated_output?.trim();
    if (output) body.push(output);
    return `${formatTranscriptHeading("CODEX", event.timestamp, "(command)")}\n${body.join("\n")}\n\n`;
  }

  if (event.type === "error" && event.message) {
    return `${formatTranscriptHeading("ERROR", event.timestamp)}\n${event.message}\n\n`;
  }

  return null;
}

function flushCodexTranscriptBuffer(
  text: string,
  carry: string,
  transcript: NodeJS.WritableStream
): string {
  const lines = (carry + text).split(/\r?\n/);
  const remainder = lines.pop() || "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const rendered = formatCodexEventForTranscript(JSON.parse(line) as CodexEvent);
      if (rendered) transcript.write(rendered);
    } catch {
      // Ignore malformed JSON lines in the transcript stream.
    }
  }

  return remainder;
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
  const inheritedModel = normalizeModel(
    parentTask.model,
    getDefaultModelForRuntime(config, inheritedRunner)
  );
  const inheritedEffort =
    normalizeEffort(inheritedRunner, parentTask.effort, config) ||
    getDefaultEffortForRuntime(config, inheritedRunner);
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
      model: inheritedModel,
      effort: inheritedEffort,
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

async function handleRunTimeout(
  taskId: string,
  durationMs: number,
  timeoutMs: number
): Promise<void> {
  const { getTask } = await import("./store");
  const currentTask = await getTask(taskId);
  const resumedUpdates = currentTask
    ? buildInterruptedTaskUpdates(currentTask)
    : { current_run_pid: undefined };

  await updateTask(taskId, {
    ...resumedUpdates,
    last_run_result: "timeout",
    error_log: `Timed out after ${timeoutMs}ms`,
    last_run_at: new Date().toISOString(),
    total_duration_ms: (currentTask?.total_duration_ms || 0) + durationMs,
    run_count: (currentTask?.run_count || 0) + 1,
  });
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
    const { getTask } = await import("./store");
    const currentTask = await getTask(taskId);

    const inputTokens = (result.usage?.input_tokens || 0) + (result.usage?.cache_read_input_tokens || 0);
    const outputTokens = result.usage?.output_tokens || 0;
    const didFail = exitCode !== 0 || result.is_error;
    const isBudgetExceeded = result.terminal_reason === "budget_exceeded";
    // `handleRunComplete` parses whatever payload the runtime returned before
    // it decides whether the run succeeded, so only apply review/follow-up
    // side effects when the exit status and terminal reason are both healthy.
    const shouldApplySuccessSideEffects = !didFail && !isBudgetExceeded;

    const updates: Partial<Task> = {
      session_id: result.session_id,
      last_run_result: didFail ? "error" : "success",
      last_run_input_tokens: inputTokens,
      last_run_output_tokens: outputTokens,
      current_run_pid: undefined,
      last_run_at: new Date().toISOString(),
    };

    if (isBudgetExceeded) {
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
      if (
        shouldApplySuccessSideEffects &&
        runReason !== "cleanup" &&
        (report.status === "completed" || report.status === "needs_review")
      ) {
        if (report.pr_url) {
          updates.status = "in_review";
        }
      }
    } else if (shouldApplySuccessSideEffects) {
      // Fallback: regex-match PR URL from plain text result
      const prMatch = result.result?.match(
        /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/
      );
      if (prMatch && runReason !== "cleanup") {
        updates.pr_url = prMatch[0];
        updates.status = "in_review";
      }
    }

    // Accumulate costs and run count
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
      if (followups?.length && shouldApplySuccessSideEffects) {
        await createFollowupTasks(currentTask, followups);
      }
    }

    // Capture GH state hash AFTER run so we don't re-trigger on our own changes
    // But if new submitted comments appeared mid-run, skip hash update so next poll picks them up
    const prUrl = updates.pr_url || currentTask?.pr_url;
    if (prUrl && shouldApplySuccessSideEffects && runReason !== "manual_instruction") {
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
    } else if (prUrl && shouldApplySuccessSideEffects) {
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
  buildModelArgs,
  buildPermissionArgs,
  createFollowupTasks,
  ensureWorktree,
  handleRunComplete,
  handleRunTimeout,
  parseCodexResult,
};
