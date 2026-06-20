import { spawn, type ChildProcess } from "child_process";
import { buildEnv, buildModelArgsWith, buildPermissionArgs } from "./runtime-args";
import { readReviewLearnings } from "./review-learnings-store";
import {
  getReviewSummary,
  patchReviewSummary,
  upsertReviewSummary,
} from "./review-store";
import { readConfig } from "./store";
import {
  DEFAULT_TASK_RUN_TIMEOUT_MS,
  resolveTaskRunTimeoutMs,
} from "./run-timeout";
import type {
  AgentRuntime,
  OrchestratorConfig,
  ReviewAgentStatus,
  ReviewFollowup,
  ReviewRequest,
  ReviewSummary,
  TaskEffort,
} from "./types";

const REVIEW_AGENT_STATUSES: ReviewAgentStatus[] = [
  "ready_for_human_approval",
  "needs_author_changes",
  "needs_human_decision",
  "blocked",
];

export const DEFAULT_REVIEW_SUMMARY_PROMPT = `You are reviewing an open pull request that the signed-in user has been asked to review.

Use the gh CLI (\`gh pr view\`, \`gh pr diff\`, etc.) to read the PR, then produce a focused review as **GitHub-flavored Markdown**. Keep the existing review standard: surface the findings you would normally surface, but leave GitHub comments yourself when a finding requires the PR author to make a change. If you are unsure whether something should be posted as a PR comment, keep it in the generated review instead.

Do not approve or request changes on GitHub.`;
export const DEFAULT_REVIEW_PROMPT = DEFAULT_REVIEW_SUMMARY_PROMPT;

export interface SpawnOpts {
  runtime: AgentRuntime;
  effort?: TaskEffort;
  model?: string;
}

export interface RunOutput {
  session_id?: string;
  result_text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
  exit_code: number | null;
  stderr: string;
  error?: string;
}

export function resolveReviewOpts(
  config: OrchestratorConfig,
  override?: Partial<SpawnOpts>
): SpawnOpts {
  const runtime: AgentRuntime =
    override?.runtime || config.review_runtime || config.default_agent_runner || "claude";
  const effort: TaskEffort | undefined =
    override?.effort ??
    config.review_effort ??
    (runtime === "codex" ? config.default_codex_effort : config.default_claude_effort);
  const model =
    override?.model?.trim() ||
    config.review_model?.trim() ||
    (runtime === "codex"
      ? config.default_codex_model?.trim()
      : config.default_claude_model?.trim()) ||
    undefined;
  return { runtime, effort, model };
}

export function resolveReviewPrompt(config: OrchestratorConfig): string {
  const configured = config.review_prompt?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_REVIEW_SUMMARY_PROMPT;
}

export function resolveReviewRunTimeoutMs(
  config: Pick<OrchestratorConfig, "task_run_timeout_ms">
): number {
  return resolveTaskRunTimeoutMs(config);
}

function summaryHeadShaFor(
  review?: Pick<ReviewSummary, "head_sha" | "summary" | "summary_head_sha">
): string | undefined {
  if (!review) return undefined;
  return (
    review.summary_head_sha ||
    (review.summary?.trim() ? review.head_sha : undefined)
  );
}

function isFollowupReview(
  request: ReviewRequest,
  cached?: ReviewSummary
): boolean {
  const reviewedHeadSha = summaryHeadShaFor(cached);
  return Boolean(
    cached?.summary?.trim() &&
      reviewedHeadSha &&
      reviewedHeadSha !== request.head_sha
  );
}

function retroFields(review?: ReviewSummary) {
  return {
    retro_status: review?.retro_status,
    retro_done_at: review?.retro_done_at,
    retro_run_pid: review?.retro_run_pid,
    retro_error: review?.retro_error,
  };
}

export function buildReviewWrapperPrompt(
  config: OrchestratorConfig,
  request: ReviewRequest,
  cached?: ReviewSummary
): string {
  const base = resolveReviewPrompt(config);
  const reviewedHeadSha = summaryHeadShaFor(cached);
  const followup = isFollowupReview(request, cached);
  const sections = [
    base,
    "",
    "Cortex City review protocol:",
    "- Start the generated review with `## Summary` and put the summary before any findings.",
    "- Then include `## Agent Status` with one exact line: `Agent status: <status>`.",
    `- The status must be one of: ${REVIEW_AGENT_STATUSES.join(", ")}.`,
    [
      "- Use `ready_for_human_approval` only when you have no required",
      "author changes and no unresolved issue that should block the human reviewer.",
    ].join(" "),
    "- Use `needs_author_changes` when the author still needs to change code.",
    [
      "- Use `needs_human_decision` when the PR may be acceptable but you found",
      "uncertain or advisory points the human should decide.",
    ].join(" "),
    "- Use `blocked` when you could not complete the review.",
    "- Leave GitHub comments yourself for findings that require author changes.",
    [
      "- Put uncertain or advisory points in the generated review instead of",
      "posting them to GitHub.",
    ].join(" "),
    "- Do not approve, request changes, or submit a GitHub PR review decision.",
  ];

  if (followup) {
    sections.push(
      "",
      "This is a follow-up review because the PR changed since your previous review.",
      `Previously reviewed head SHA: ${reviewedHeadSha}`,
      `Current head SHA: ${request.head_sha}`,
      [
        "Use GitHub tooling to inspect the current PR, your prior",
        "agent-authored comments, and any relevant review threads.",
      ].join(" "),
      [
        "If a prior required-change comment has been addressed, leave a",
        "follow-up GitHub comment saying so.",
      ].join(" "),
      [
        "If a prior required-change comment is still unresolved, do not duplicate",
        "the same comment; reflect that in the generated review and status.",
      ].join(" "),
      [
        "Review the current PR fresh as well, and leave new GitHub comments for",
        "new required author changes.",
      ].join(" ")
    );
  } else {
    sections.push(
      "",
      "This is an initial review of the current PR state.",
      `Current head SHA: ${request.head_sha}`
    );
  }

  if (config.review_learning_enabled !== false) {
    const learnings = readReviewLearnings().trim();
    if (learnings) {
      sections.push(
        "",
        "## Lessons from past reviews",
        "Apply these lessons learned from previously merged PRs. Treat repo-tagged lessons as applying only to that repository.",
        "",
        learnings
      );
    }
  }

  sections.push("", `Review this PR: ${request.pr_url}`);
  return sections.join("\n");
}

export function parseReviewAgentStatus(
  text: string
): ReviewAgentStatus | undefined {
  const statusLine = text.match(
    /\bagent\s+(?:status|readiness|verdict)\b\s*[:\-]\s*`?([a-zA-Z0-9 _-]+)`?/i
  );
  const candidates = statusLine ? [statusLine[1], text] : [text];
  for (const candidate of candidates) {
    const normalized = candidate
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z_]/g, "");
    const exact = REVIEW_AGENT_STATUSES.find((status) =>
      normalized.includes(status)
    );
    if (exact) return exact;
  }
  return undefined;
}

function buildClaudeArgs(
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId?: string
): string[] {
  const args: string[] = [];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  args.push("-p", prompt, "--output-format", "json");
  args.push(...buildPermissionArgs("claude", "bypassPermissions"));
  args.push(...buildModelArgsWith("claude", opts.model, opts.effort));
  return args;
}

function buildCodexArgs(
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId?: string
): string[] {
  const args: string[] = ["exec", "--json"];
  if (resumeSessionId) {
    args.push("resume");
  }
  args.push(...buildPermissionArgs("codex", "bypassPermissions"));
  args.push(...buildModelArgsWith("codex", opts.model, opts.effort));
  if (resumeSessionId) {
    args.push(resumeSessionId);
  }
  args.push(prompt);
  return args;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

function flushCodexEvents(
  carry: string,
  text: string,
  onEvent: (event: CodexEvent) => void
): string {
  const combined = carry + text;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      onEvent(JSON.parse(line) as CodexEvent);
    } catch {
      // ignore malformed
    }
  }
  return remainder;
}

export interface SpawnResult {
  pid: number;
  child: ChildProcess;
  done: Promise<RunOutput>;
}

export function spawnRuntime(
  runtime: AgentRuntime,
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId?: string,
  runTimeoutMs = DEFAULT_TASK_RUN_TIMEOUT_MS
): SpawnResult {
  const command = runtime === "codex" ? "codex" : "claude";
  const args =
    runtime === "codex"
      ? buildCodexArgs(prompt, opts, resumeSessionId)
      : buildClaudeArgs(prompt, opts, resumeSessionId);

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: buildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end();

  let stdout = "";
  let stderr = "";
  let codexCarry = "";
  const codexResult: CodexEvent[] = [];

  const done = new Promise<RunOutput>((resolve) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    if (typeof runTimeoutMs === "number" && runTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 5000).unref?.();
      }, runTimeoutMs);
      timeout.unref?.();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (runtime === "codex") {
        codexCarry = flushCodexEvents(codexCarry, text, (event) => {
          codexResult.push(event);
        });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        result_text: "",
        exit_code: null,
        stderr: stderr + (err.message || String(err)),
        error: err.message || String(err),
        duration_ms: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      const duration = Date.now() - startedAt;
      if (runtime === "codex") {
        codexCarry = flushCodexEvents(codexCarry, "\n", (event) => {
          codexResult.push(event);
        });
        let sessionId: string | undefined;
        let resultText = "";
        let usage: RunOutput["usage"] | undefined;
        for (const event of codexResult) {
          if (event.type === "thread.started" && event.thread_id) {
            sessionId = event.thread_id;
          }
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message"
          ) {
            resultText = event.item.text || resultText;
          }
          if (event.type === "turn.completed" && event.usage) {
            usage = {
              input_tokens: event.usage.input_tokens,
              output_tokens: event.usage.output_tokens,
            };
          }
        }
        resolve({
          session_id: sessionId,
          result_text: resultText,
          usage,
          duration_ms: duration,
          exit_code: code,
          stderr,
          error: timedOut
            ? `Run timed out after ${runTimeoutMs}ms`
            : code !== 0
              ? stderr.trim() || `codex exited with code ${code}`
              : undefined,
        });
        return;
      }

      // Claude — parse JSON from stdout
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
          result_text: typeof parsed.result === "string" ? parsed.result : "",
          usage: parsed.usage
            ? {
                input_tokens: parsed.usage.input_tokens,
                output_tokens: parsed.usage.output_tokens,
              }
            : undefined,
          duration_ms:
            typeof parsed.duration_ms === "number" ? parsed.duration_ms : duration,
          exit_code: code,
          stderr,
          error: timedOut
            ? `Run timed out after ${runTimeoutMs}ms`
            : code !== 0 || parsed.is_error
              ? stderr.trim() || `claude exited with code ${code}`
              : undefined,
        });
      } catch (err) {
        const fallbackError = timedOut
          ? `Run timed out after ${runTimeoutMs}ms`
          : code !== 0
            ? stderr.trim() || `claude exited with code ${code}`
            : `Failed to parse claude output: ${(err as Error).message}`;
        resolve({
          result_text: stdout,
          exit_code: code,
          stderr,
          duration_ms: duration,
          error: fallbackError,
        });
      }
    });
  });

  return { pid: child.pid!, child, done };
}

export type SpawnReviewSummaryOptions = Partial<SpawnOpts>;

export interface SpawnedReview {
  pid: number;
  child: ChildProcess;
  done: Promise<ReviewSummary>;
}

export async function spawnReviewSummary(
  request: ReviewRequest,
  options: SpawnReviewSummaryOptions = {},
  onComplete?: (summary: ReviewSummary) => Promise<void> | void
): Promise<SpawnedReview> {
  const config = readConfig();
  const opts = resolveReviewOpts(config, options);
  const runTimeoutMs = resolveReviewRunTimeoutMs(config);

  const cachedBefore = getReviewSummary(request.pr_url);
  const cachedSummaryHeadSha = summaryHeadShaFor(cachedBefore);
  const followupReview = isFollowupReview(request, cachedBefore);
  const prompt = buildReviewWrapperPrompt(config, request, cachedBefore);
  const resumeSessionId =
    followupReview && cachedBefore?.session_id
      ? cachedBefore.session_id
      : undefined;
  const baseEntry = {
    ...request,
    summary: cachedBefore?.summary ?? "",
    summary_head_sha: cachedSummaryHeadSha,
    generated_at: cachedBefore?.generated_at ?? "",
    runtime: cachedBefore?.runtime,
    effort: cachedBefore?.effort,
    model: cachedBefore?.model,
    session_id: cachedBefore?.session_id,
    duration_ms: cachedBefore?.duration_ms,
    input_tokens: cachedBefore?.input_tokens,
    output_tokens: cachedBefore?.output_tokens,
    agent_review_status: followupReview
      ? undefined
      : cachedBefore?.agent_review_status,
    followups: cachedBefore?.followups,
    final_at: cachedBefore?.final_at,
    error: cachedBefore?.error,
    ...retroFields(cachedBefore),
  };

  const { pid, child, done } = spawnRuntime(
    opts.runtime,
    prompt,
    opts,
    resumeSessionId,
    runTimeoutMs
  );

  await upsertReviewSummary({
    ...baseEntry,
    current_run_pid: pid,
  });

  const completion = done.then(async (output) => {
    let finalOutput = output;
    if (output.error && resumeSessionId) {
      const fallbackPrompt = [
        "The previous review session could not be resumed.",
        [
          "Start a fresh session and reconstruct context from GitHub comments,",
          "review threads, and the current PR state.",
        ].join(" "),
        "",
        prompt,
      ].join("\n");
      const fallback = spawnRuntime(
        opts.runtime,
        fallbackPrompt,
        opts,
        undefined,
        runTimeoutMs
      );
      await patchReviewSummary(request.pr_url, { current_run_pid: fallback.pid });
      finalOutput = await fallback.done;
    }

    const generatedAt = new Date().toISOString();
    const successful = !finalOutput.error;
    const latestBeforeSave = getReviewSummary(request.pr_url) || cachedBefore;
    const next = {
      ...request,
      summary: successful
        ? finalOutput.result_text.trim()
        : (cachedBefore?.summary ?? ""),
      summary_head_sha: successful ? request.head_sha : cachedSummaryHeadSha,
      generated_at: successful ? generatedAt : cachedBefore?.generated_at ?? "",
      runtime: opts.runtime,
      effort: opts.effort,
      model: opts.model,
      session_id:
        finalOutput.session_id ||
        (successful ? resumeSessionId : cachedBefore?.session_id) ||
        undefined,
      duration_ms: finalOutput.duration_ms,
      input_tokens: finalOutput.usage?.input_tokens,
      output_tokens: finalOutput.usage?.output_tokens,
      error: finalOutput.error,
      agent_review_status: successful
        ? parseReviewAgentStatus(finalOutput.result_text)
        : cachedBefore?.agent_review_status,
      followups:
        followupReview || finalOutput.error ? cachedBefore?.followups || [] : [],
      final_at: undefined,
      current_run_pid: undefined,
      ...retroFields(latestBeforeSave),
    };
    const saved = await upsertReviewSummary(next);
    if (onComplete) {
      await onComplete(saved);
    }
    return saved;
  });

  return { pid, child, done: completion };
}

export async function summarizePR(
  request: ReviewRequest,
  options: SpawnReviewSummaryOptions = {}
): Promise<ReviewSummary> {
  const spawned = await spawnReviewSummary(request, options);
  return spawned.done;
}

export async function askFollowup(
  prUrl: string,
  question: string
): Promise<ReviewFollowup> {
  const cached = getReviewSummary(prUrl);
  if (!cached) {
    throw new Error("No summary to follow up on; generate one first.");
  }
  if (!cached.summary) {
    throw new Error("Summary is not yet available for this PR.");
  }
  if (cached.current_run_pid != null) {
    throw new Error("Summary is being refreshed for this PR.");
  }
  const config = readConfig();
  const runTimeoutMs = resolveReviewRunTimeoutMs(config);
  const runtime: AgentRuntime =
    cached.runtime || config.review_runtime || config.default_agent_runner || "claude";
  const effort: TaskEffort | undefined = cached.effort ?? config.review_effort;
  const model = cached.model ?? config.review_model;
  const opts: SpawnOpts = { runtime, effort, model };

  const askedAt = new Date().toISOString();
  const isSummaryStale =
    Boolean(cached.summary_head_sha) && cached.summary_head_sha !== cached.head_sha;
  const followupPrompt = [
    `PR URL: ${prUrl}`,
    isSummaryStale
      ? `The cached summary was generated for ${cached.summary_head_sha}, but the current head is ${cached.head_sha}. Answer against the current PR state when the latest code matters.`
      : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (cached.session_id) {
    const resumed = spawnRuntime(
      runtime,
      followupPrompt,
      opts,
      cached.session_id,
      runTimeoutMs
    );
    const result = await resumed.done;
    if (!result.error && result.result_text.trim()) {
      return {
        asked_at: askedAt,
        question,
        answered_at: new Date().toISOString(),
        answer: result.result_text.trim(),
        session_id: result.session_id || cached.session_id,
        resumed: true,
      };
    }
  }

  const seededPrompt = [
    "You previously produced the following review summary for this PR:",
    `PR URL: ${prUrl}`,
    cached.summary_head_sha ? `Summary head SHA: ${cached.summary_head_sha}` : "",
    `Current head SHA: ${cached.head_sha}`,
    isSummaryStale
      ? "The summary may be stale. Use it as context, and inspect the current PR with tools if the question depends on latest code."
      : "",
    "<summary>",
    cached.summary,
    "</summary>",
    "",
    "The user is asking a follow-up question. Use the summary plus any tools you have to answer.",
    "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  const fresh = spawnRuntime(runtime, seededPrompt, opts, undefined, runTimeoutMs);
  const result = await fresh.done;
  return {
    asked_at: askedAt,
    question,
    answered_at: new Date().toISOString(),
    answer: (result.result_text || "").trim(),
    session_id: result.session_id,
    resumed: false,
    error: result.error,
  };
}

export async function appendFollowup(
  prUrl: string,
  followup: ReviewFollowup
): Promise<ReviewSummary | undefined> {
  const current = getReviewSummary(prUrl);
  if (!current) return undefined;
  const followups = [...(current.followups || []), followup];
  return patchReviewSummary(prUrl, { followups });
}
