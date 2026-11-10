import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync, type WriteStream } from "fs";
import path from "path";
import { buildModelArgs, buildReviewPermissionArgs, __testUtils as runtimeArgsUtils } from "./runtime-args";
import { getDefaultEffortForRuntime, getDefaultModelForRuntime } from "./runtime-config";
import { readConfig } from "./store";
import { readSecretValues, type ResolvedSecret } from "./secret-store";
import {
  DEFAULT_ROUTINE_MAX_RUN_MB,
  DEFAULT_ROUTINE_TIMEOUT_MINUTES,
  getRoutine,
  getRun,
  normalizeChannel,
  runArtifactsDir,
  runDataDir,
  runTranscriptPath,
  updateRun,
} from "./routine-store";
import { buildRoutinePrompt, parseRoutineReport, ROUTINE_REPORT_SCHEMA, type ParsedRoutineReport } from "./routine-prompt";
import { captureArtifacts, createRedactor, resolveStoredArtifact, type Redactor } from "./routine-artifacts";
import { getSlackToken, sendSlackMessage, type FetchLike } from "./slack";
import type { AgentRuntime, Routine, RoutineRun, RoutineSlackMessage } from "./types";

export const MAX_SLACK_ATTEMPTS = 5;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;

export function routineWorkspaceRoot(): string {
  const configured = process.env.CORTEX_ROUTINE_WORKSPACE_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(/* turbopackIgnore: true */ process.cwd(), "tmp", "routines");
}

export function runWorkspaceDir(runId: string): string {
  return path.join(routineWorkspaceRoot(), runId);
}

// Environment variables passed through from the worker. Everything else in the
// worker's environment (and the global or agent .env files) stays out of a
// routine's process; secrets arrive only through the routine's own grants.
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
];
// Credentials the agent runtime itself needs to start. These may live in the
// worker environment or the global .env, as they do for task runs.
const RUNTIME_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];
// Cloud-provider credentials, passed only when Claude is configured to use
// that provider.
const PROVIDER_AUTH_ENV: Record<string, string[]> = {
  CLAUDE_CODE_USE_BEDROCK: ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"],
  CLAUDE_CODE_USE_VERTEX: ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID"],
};

export function buildRoutineEnv(
  secrets: ResolvedSecret[],
  options: { workspace: string; outputDir: string; secretsDir: string; routine: Routine; run: RoutineRun },
  baseEnv: NodeJS.ProcessEnv = process.env,
  globalEnvFile = path.join(/* turbopackIgnore: true */ process.cwd(), ".env")
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of PASSTHROUGH_ENV) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  const globalEnv = runtimeArgsUtils.loadEnvFile(globalEnvFile);
  for (const key of RUNTIME_AUTH_ENV) {
    const value = baseEnv[key] ?? globalEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [flag, keys] of Object.entries(PROVIDER_AUTH_ENV)) {
    if (!env[flag]) continue;
    for (const key of keys) {
      const value = baseEnv[key] ?? globalEnv[key];
      if (value !== undefined) env[key] = value;
    }
  }
  const tmp = path.join(options.workspace, "tmp");
  env.TMPDIR = tmp;
  env.TMP = tmp;
  env.TEMP = tmp;
  env.CORTEX_OUTPUT_DIR = options.outputDir;
  env.CORTEX_ROUTINE_ID = options.routine.id;
  env.CORTEX_ROUTINE_NAME = options.routine.name;
  env.CORTEX_ROUTINE_RUN = String(options.run.number);
  for (const secret of secrets) {
    if (secret.kind === "file") {
      const file = path.join(options.secretsDir, secret.name);
      writeFileSync(file, secret.value, { mode: 0o600 });
      env[secret.name] = file;
    } else {
      env[secret.name] = secret.value;
    }
  }
  return env;
}

export interface ResolvedRoutineSecrets {
  secrets: ResolvedSecret[];
  used: RoutineRun["secrets_used"];
  missing: string[];
}

/** Globals the routine ticked, then its own secrets (which win on a clash). */
export function resolveRoutineSecrets(routine: Routine): ResolvedRoutineSecrets {
  const globals = readSecretValues({ kind: "global" }, routine.global_secrets);
  const missing = routine.global_secrets.filter((name) => !globals.some((secret) => secret.name === name));
  const locals = readSecretValues({ kind: "routine", routineId: routine.id });
  const merged = new Map<string, { secret: ResolvedSecret; scope: "global" | "routine" }>();
  for (const secret of globals) merged.set(secret.name, { secret, scope: "global" });
  for (const secret of locals) merged.set(secret.name, { secret, scope: "routine" });
  const entries = [...merged.values()];
  return {
    secrets: entries.map((entry) => entry.secret),
    used: entries.map((entry) => ({ name: entry.secret.name, scope: entry.scope })),
    missing,
  };
}

// --- Output stream parsing (Claude stream-json and Codex exec --json) ---

interface StreamState {
  sessionId?: string;
  finalText?: string;
  structured?: unknown;
  usage?: { input: number; cached: number; output: number };
  isError?: boolean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function truncateForTranscript(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** Updates `state` from one event and returns transcript text for it, if any. */
export function handleStreamEvent(runtime: AgentRuntime, event: JsonRecord, state: StreamState): string | undefined {
  if (runtime === "codex") {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      state.sessionId = event.thread_id;
      return `SYSTEM\nSession started: ${event.thread_id}\n\n`;
    }
    const item = asRecord(event.item);
    if (event.type === "item.completed" && item?.type === "agent_message") {
      const text = typeof item.text === "string" ? item.text : "";
      state.finalText = text;
      return `CODEX\n${truncateForTranscript(text)}\n\n`;
    }
    if (event.type === "item.completed" && item?.type === "command_execution") {
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
      return `CODEX (command)\n$ ${String(item.command ?? "")}${output ? `\n${truncateForTranscript(output)}` : ""}\n\n`;
    }
    const usage = asRecord(event.usage);
    if (event.type === "turn.completed" && usage) {
      state.usage = {
        input: Number(usage.input_tokens) || 0,
        cached: Number(usage.cached_input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
      };
      return undefined;
    }
    if (event.type === "error" && typeof event.message === "string") {
      return `ERROR\n${event.message}\n\n`;
    }
    return undefined;
  }

  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    state.sessionId = event.session_id;
    return `SYSTEM\nSession started: ${event.session_id}\n\n`;
  }
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
  if (event.type === "assistant") {
    const parts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block?.type === "tool_use") {
        parts.push(`[tool] ${String(block.name ?? "")} ${truncateForTranscript(JSON.stringify(block.input ?? {}), 1500)}`);
      }
    }
    return parts.length ? `CLAUDE\n${parts.join("\n")}\n\n` : undefined;
  }
  if (event.type === "user") {
    const parts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type !== "tool_result") continue;
      const value = block.content;
      const text = typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value.map((part) => (typeof asRecord(part)?.text === "string" ? String(asRecord(part)!.text) : "")).join("\n")
          : "";
      if (text.trim()) parts.push(truncateForTranscript(text.trim(), 2000));
    }
    return parts.length ? `TOOL RESULT\n${parts.join("\n")}\n\n` : undefined;
  }
  if (event.type === "result") {
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (typeof event.result === "string") state.finalText = event.result;
    if (event.structured_output !== undefined) state.structured = event.structured_output;
    state.isError = event.is_error === true;
    const usage = asRecord(event.usage);
    if (usage) {
      state.usage = {
        input: Number(usage.input_tokens) || 0,
        cached: Number(usage.cache_read_input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
      };
    }
    return `RESULT\n${truncateForTranscript(typeof event.result === "string" ? event.result : "")}\n\n`;
  }
  return undefined;
}

export function reportFromStream(state: StreamState): ParsedRoutineReport | undefined {
  return parseRoutineReport(state.structured) ?? parseRoutineReport(state.finalText ?? "");
}

// --- Run lifecycle ---

export interface RoutineRunnerDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch: FetchLike;
  now: () => Date;
}

export const defaultRoutineRunnerDeps: RoutineRunnerDeps = {
  spawn: (command, args, options) => nodeSpawn(command, args, options),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

export interface StartedRoutineRun {
  pid?: number;
  completion: Promise<RoutineRun | undefined>;
}

function publicRunUrl(routine: Routine, run: RoutineRun): string | undefined {
  const base = process.env.CORTEX_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/routines/${routine.id}/runs/${run.id}` : undefined;
}

function failureNotice(routine: Routine, run: RoutineRun, status: RoutineRun["status"], error?: string): RoutineSlackMessage | undefined {
  if (!routine.slack.failure_channel) return undefined;
  const what = status === "timeout" ? "timed out" : "failed";
  const url = publicRunUrl(routine, run);
  const text = [
    `Routine *${routine.name}* run #${run.number} ${what}.`,
    error ? `> ${error.split("\n")[0].slice(0, 300)}` : undefined,
    url ? url : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    channel: routine.slack.failure_channel,
    text,
    attachments: [],
    kind: "failure_notice",
    status: "pending",
    attempts: 0,
  };
}

function isChannelAllowed(routine: Routine, channel: string): boolean {
  const normalized = normalizeChannel(channel);
  return routine.slack.allowed_channels.some((allowed) => normalizeChannel(allowed) === normalized);
}

export interface FinalizeInput {
  status?: RoutineRun["status"];
  report?: ParsedRoutineReport;
  error?: string;
  sessionId?: string;
  usage?: StreamState["usage"];
}

/**
 * Captures what the run left in its output folder, records the result and
 * queues Slack messages, then deletes the run's workspace. Also used for runs
 * interrupted by a worker restart, so partial output is still kept.
 */
export async function finalizeRoutineRun(
  routine: Routine,
  run: RoutineRun,
  input: FinalizeInput,
  deps: RoutineRunnerDeps = defaultRoutineRunnerDeps,
  redact: Redactor = createRedactor(resolveRoutineSecrets(routine).secrets)
): Promise<RoutineRun | undefined> {
  const workspace = runWorkspaceDir(run.id);
  const outputDir = path.join(workspace, "out");
  const report = input.report;
  const maxBytes = (routine.max_run_mb ?? DEFAULT_ROUTINE_MAX_RUN_MB) * 1024 * 1024;
  const capture = existsSync(outputDir)
    ? captureArtifacts(outputDir, runArtifactsDir(routine.id, run.id), report?.artifacts ?? [], {
        maxBytes,
        redact,
      })
    : { artifacts: [], bytes: 0, truncated: false, skipped: [] };

  let status: RoutineRun["status"] = input.status ?? "failed";
  if (!input.status) {
    if (!report) status = "failed";
    else if (report.status === "completed") status = "succeeded";
    else if (report.status === "needs_attention") status = "needs_attention";
    else status = "failed";
  }
  let error = input.error ? redact(input.error) : undefined;
  if (!error && status === "failed" && !report) error = "The agent finished without a valid report.";
  if (capture.truncated) {
    const note = `Some files were not kept because the run went over its ${routine.max_run_mb ?? DEFAULT_ROUTINE_MAX_RUN_MB} MB limit: ${capture.skipped.slice(0, 10).join(", ")}`;
    error = error ? `${error}\n${note}` : note;
  }

  const stored = new Set(capture.artifacts.map((artifact) => artifact.path));
  const messages: RoutineSlackMessage[] = [];
  for (const request of report?.slack_messages ?? []) {
    const attachments: string[] = [];
    const missing: string[] = [];
    for (const reported of request.attachments) {
      const normalized = reported.replace(/^\.?\/+/, "").replace(/^out\//, "");
      if (stored.has(normalized)) attachments.push(normalized);
      else missing.push(reported);
    }
    const allowed = isChannelAllowed(routine, request.channel);
    messages.push({
      channel: request.channel,
      text: redact(request.text),
      attachments,
      kind: "agent",
      status: allowed ? "pending" : "refused",
      attempts: 0,
      ...(allowed
        ? missing.length
          ? { error: `Attachments not found: ${missing.join(", ")}` }
          : {}
        : { error: "Channel isn't on this routine's allowed list." }),
    });
  }
  if (status === "failed" || status === "timeout") {
    const notice = failureNotice(routine, run, status, error);
    if (notice) messages.push(notice);
  }

  const finished = await updateRun(routine.id, run.id, (current) => ({
    status,
    finished_at: deps.now().toISOString(),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.usage
      ? {
          input_tokens: input.usage.input,
          cached_input_tokens: input.usage.cached,
          output_tokens: input.usage.output,
        }
      : {}),
    ...(report ? { report: { status: report.status, summary: redact(report.summary) } } : {}),
    artifacts: capture.artifacts,
    artifacts_bytes: capture.bytes,
    ...(capture.truncated ? { artifacts_truncated: true } : {}),
    slack_messages: [...current.slack_messages, ...messages],
    ...(error ? { error } : {}),
    pid: undefined,
  }));

  rmSync(workspace, { recursive: true, force: true });
  if (finished) return deliverPendingSlackMessages(routine, finished, deps);
  return finished;
}

/** Sends pending (or previously failed) messages; safe to call repeatedly. */
export async function deliverPendingSlackMessages(
  routine: Routine,
  run: RoutineRun,
  deps: Pick<RoutineRunnerDeps, "fetch" | "now"> = defaultRoutineRunnerDeps
): Promise<RoutineRun | undefined> {
  const due = run.slack_messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        (message.status === "pending" || message.status === "failed") && message.attempts < MAX_SLACK_ATTEMPTS
    );
  if (due.length === 0) return run;
  const token = getSlackToken();
  const results = new Map<number, Partial<RoutineSlackMessage>>();
  for (const { message, index } of due) {
    if (!token) {
      results.set(index, {
        status: "failed",
        attempts: MAX_SLACK_ATTEMPTS,
        error: "Slack isn't connected. Add a bot token in Settings → Integrations.",
      });
      continue;
    }
    try {
      const files = message.attachments.flatMap((relative) => {
        const filePath = resolveStoredArtifact(runArtifactsDir(routine.id, run.id), relative);
        const artifact = run.artifacts.find((entry) => entry.path === relative);
        return filePath ? [{ filePath, title: artifact?.title ?? relative }] : [];
      });
      await sendSlackMessage(token, { channel: message.channel, text: message.text, files }, deps.fetch);
      results.set(index, { status: "sent", attempts: message.attempts + 1, sent_at: deps.now().toISOString(), error: undefined });
    } catch (error) {
      results.set(index, {
        status: "failed",
        attempts: message.attempts + 1,
        error: (error as Error).message,
      });
    }
  }
  return updateRun(routine.id, run.id, (current) => ({
    slack_messages: current.slack_messages.map((message, index) =>
      results.has(index) ? { ...message, ...results.get(index) } : message
    ),
  }));
}

function openTranscript(routine: Routine, run: RoutineRun): { write: (text: string) => void; end: () => void } {
  mkdirSync(runDataDir(routine.id, run.id), { recursive: true });
  const stream: WriteStream = createWriteStream(runTranscriptPath(routine.id, run.id), { flags: "a" });
  let written = 0;
  let truncated = false;
  return {
    write(text: string) {
      if (truncated) return;
      const bytes = Buffer.byteLength(text);
      if (written + bytes > MAX_TRANSCRIPT_BYTES) {
        truncated = true;
        stream.write("\n[Transcript truncated: it reached the 5 MB limit.]\n");
        return;
      }
      written += bytes;
      stream.write(text);
    },
    end() {
      stream.end();
    },
  };
}

export async function startRoutineRun(
  routine: Routine,
  run: RoutineRun,
  deps: RoutineRunnerDeps = defaultRoutineRunnerDeps
): Promise<StartedRoutineRun> {
  const config = readConfig();
  const runtime: AgentRuntime = routine.agent_runner || config.default_agent_runner || "claude";
  const workspace = runWorkspaceDir(run.id);
  const outputDir = path.join(workspace, "out");
  const secretsDir = path.join(workspace, ".secrets");
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(path.join(workspace, "tmp"), { recursive: true });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const resolved = resolveRoutineSecrets(routine);
  const redact = createRedactor(resolved.secrets);
  const transcript = openTranscript(routine, run);

  if (resolved.missing.length > 0) {
    transcript.end();
    const completion = finalizeRoutineRun(
      routine,
      { ...run, secrets_used: resolved.used },
      {
        status: "failed",
        error: `Missing secret${resolved.missing.length > 1 ? "s" : ""}: ${resolved.missing.join(", ")}. Add ${resolved.missing.length > 1 ? "them" : "it"} in Settings → Secrets or untick ${resolved.missing.length > 1 ? "them" : "it"} on the routine.`,
      },
      deps,
      redact
    );
    await updateRun(routine.id, run.id, { secrets_used: resolved.used });
    return { completion };
  }

  const prompt = buildRoutinePrompt(routine, {
    outputDir,
    secrets: resolved.secrets,
    runNumber: run.number,
    now: deps.now(),
  });
  const schema = JSON.stringify(ROUTINE_REPORT_SCHEMA);
  const args: string[] = [];
  if (runtime === "codex") {
    const schemaPath = path.join(workspace, "report-schema.json");
    writeFileSync(schemaPath, schema);
    args.push("exec", "--json", "--output-schema", schemaPath);
  } else {
    args.push("-p", prompt, "--output-format", "stream-json", "--verbose", "--json-schema", schema);
  }
  args.push(...buildReviewPermissionArgs(runtime));
  args.push(...buildModelArgs(runtime, { model: routine.model, effort: routine.effort }, config));
  if (runtime === "codex") args.push(prompt);

  const env = buildRoutineEnv(resolved.secrets, { workspace, outputDir, secretsDir, routine, run });
  transcript.write(`USER (routine prompt)\n${redact(prompt)}\n\n`);

  const state: StreamState = {};
  let stdoutCarry = "";
  let stderrTail = "";
  let timedOut = false;
  let finalized = false;
  let resolveCompletion!: (value: RoutineRun | undefined) => void;
  const completion = new Promise<RoutineRun | undefined>((resolve) => {
    resolveCompletion = resolve;
  });

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("{")) {
      try {
        const text = handleStreamEvent(runtime, JSON.parse(trimmed) as JsonRecord, state);
        if (text) transcript.write(redact(text));
        return;
      } catch {
        // Not JSON after all; keep it as plain output.
      }
    }
    transcript.write(`${redact(trimmed)}\n`);
  };

  let child: ChildProcess;
  try {
    child = deps.spawn(runtime === "codex" ? "codex" : "claude", args, {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    transcript.end();
    const completionPromise = finalizeRoutineRun(
      routine,
      run,
      { status: "failed", error: `Could not start ${runtime}: ${(error as Error).message}` },
      deps,
      redact
    );
    return { completion: completionPromise };
  }
  child.stdin?.end();

  const timeoutMinutes = routine.timeout_minutes ?? DEFAULT_ROUTINE_TIMEOUT_MINUTES;
  let killTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    transcript.write(`SYSTEM\nTimed out after ${timeoutMinutes} minutes; stopping the agent.\n\n`);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  }, timeoutMinutes * 60 * 1000);
  timeoutTimer.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = (stdoutCarry + chunk.toString("utf-8")).split(/\r?\n/);
    stdoutCarry = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-4000);
  });

  const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (stdoutCarry) handleLine(stdoutCarry);
    stdoutCarry = "";
    if (stderrTail.trim()) transcript.write(`STDERR\n${redact(stderrTail.trim())}\n\n`);
    transcript.end();
    const latest = getRun(routine.id, run.id) ?? run;
    const report = reportFromStream(state);
    let status: RoutineRun["status"] | undefined;
    let error: string | undefined;
    if (spawnError) {
      status = "failed";
      error = `Could not start ${runtime}: ${spawnError.message}`;
    } else if (timedOut) {
      status = "timeout";
      error = `Timed out after ${timeoutMinutes} minutes.`;
    } else if (latest.stop_requested) {
      status = "failed";
      error = "Stopped from Cortex City.";
    } else if (!report) {
      status = "failed";
      const detail = stderrTail.trim().split("\n").slice(-3).join("\n");
      error = `The agent exited (${signal ?? `code ${exitCode}`}) without a valid report.${detail ? `\n${detail}` : ""}`;
    }
    try {
      const result = await finalizeRoutineRun(
        routine,
        latest,
        { status, report, error, sessionId: state.sessionId, usage: state.usage },
        deps,
        redact
      );
      resolveCompletion(result);
    } catch (finalizeError) {
      console.error(`[routines] Failed to finalize run ${run.id}:`, finalizeError);
      resolveCompletion(undefined);
    }
  };

  child.on("error", (error) => void finish(null, null, error));
  child.on("close", (code, signal) => void finish(code, signal));

  await updateRun(routine.id, run.id, {
    status: "running",
    started_at: deps.now().toISOString(),
    pid: child.pid,
    runtime,
    model: routine.model || getDefaultModelForRuntime(config, runtime) || undefined,
    effort: routine.effort || getDefaultEffortForRuntime(config, runtime),
    secrets_used: resolved.used,
  });

  return { pid: child.pid, completion };
}

/** Finalizes a run whose process is gone (e.g. the worker restarted). */
export async function finalizeInterruptedRun(
  routineId: string,
  run: RoutineRun,
  deps: RoutineRunnerDeps = defaultRoutineRunnerDeps
): Promise<RoutineRun | undefined> {
  const routine = getRoutine(routineId);
  if (!routine) return undefined;
  return finalizeRoutineRun(
    routine,
    run,
    {
      status: "failed",
      error:
        run.status === "queued"
          ? "Interrupted before it started (the worker restarted)."
          : "Interrupted: the worker restarted during this run.",
    },
    deps
  );
}
