import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdirSync } from "fs";
import os from "os";
import path from "path";
import * as lockfile from "proper-lockfile";
import {
  buildEnv,
  buildModelArgsWith,
  buildReviewPermissionArgs,
} from "./runtime-args";
import {
  assertSufficientReviewDiskSpace,
  LowDiskSpaceError,
  monitorReviewDiskSpace,
  type ReviewDiskGuardOptions,
} from "./disk-guard";
import {
  createReviewWorkspace,
  markReviewWorkspaceActive,
  releaseReviewWorkspace,
  releaseReviewWorkspaceBeforeStart,
} from "./review-workspace";
import {
  REVIEWER_GITHUB_COMMENT_PREFIX,
  REVIEWER_HUMAN_DECISION_COMMENT_PREFIX,
  REVIEWER_SELF_APPROVAL_COMMENT_PREFIX,
} from "./review-comments";
import { readReviewLearnings } from "./review-learnings-store";
import {
  getReviewSummary,
  mutateReviewSummary,
  patchReviewSummary,
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
  ReviewSessionProfile,
  ReviewSource,
  ReviewSummary,
  TaskEffort,
} from "./types";

export { REVIEWER_GITHUB_COMMENT_PREFIX } from "./review-comments";

interface ReviewRunLockData {
  token: string;
}

interface ReviewRunLock {
  data: ReviewRunLockData;
  release: () => Promise<void>;
  compromised: () => Error | undefined;
}

const REVIEW_RUN_LOCK_STALE_MS = 30_000;
const REVIEW_RUN_LOCK_UPDATE_MS = 10_000;

export class ReviewRunInFlightError extends Error {}

function isProcessRunning(pid?: number): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reviewRunLockTarget(prUrl: string): string {
  const workspaceKey = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 20);
  const prKey = createHash("sha256").update(prUrl).digest("hex");
  const directory = path.join(
    os.tmpdir(),
    "cortex-city-review-locks",
    workspaceKey
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${prKey}.run`);
}

async function acquireReviewRunLock(prUrl: string): Promise<ReviewRunLock> {
  const target = reviewRunLockTarget(prUrl);
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      stale: REVIEW_RUN_LOCK_STALE_MS,
      update: REVIEW_RUN_LOCK_UPDATE_MS,
      retries: 0,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ELOCKED") {
      throw new ReviewRunInFlightError(
        `A review run is already in flight for ${prUrl}`
      );
    }
    throw error;
  }

  const persisted = getReviewSummary(prUrl);
  if (
    persisted?.current_run_pid &&
    isProcessRunning(persisted.current_run_pid)
  ) {
    await release();
    throw new ReviewRunInFlightError(
      `A review run is already in flight for ${prUrl}`
    );
  }

  return {
    data: { token: randomUUID() },
    release,
    compromised: () => compromised,
  };
}

function assertReviewRunLockHealthy(lock: ReviewRunLock): void {
  const compromised = lock.compromised();
  if (compromised) throw compromised;
}

async function releaseReviewRunLock(lock: ReviewRunLock): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    if (!lock.compromised()) throw error;
  }
}

const REVIEW_AGENT_STATUSES: ReviewAgentStatus[] = [
  "ready_for_human_approval",
  "needs_author_changes",
  "needs_human_decision",
  "blocked",
];

const REVIEWER_SEPARATE_FOLLOWUP_COMMENT_PREFIX =
  `${REVIEWER_GITHUB_COMMENT_PREFIX} **Separate follow-up suggested (non-blocking):**`;
const REVIEW_GITHUB_TOOL_INSTRUCTION =
  "Use the `gh` CLI for GitHub inspection and comments. The working directory persists for this PR, so reuse any existing checkout or artifacts.";

const REVIEWER_SELF_APPROVAL_COMMENT_BODY =
  "Cortex City found no blocking issues and would approve this PR, but GitHub does not allow the PR author to approve their own pull request. Please ask an eligible non-author reviewer to approve it, or make the appropriate manual merge or coordination decision if repository policy permits.";

export const DEFAULT_REVIEW_SUMMARY_PROMPT = `You are reviewing an open pull request with Cortex City's unified review agent.

Use the gh CLI (\`gh pr view\`, \`gh pr diff\`, etc.) to read the PR, then produce a focused review as **GitHub-flavored Markdown**. Keep the existing review standard: surface the findings you would normally surface, but leave GitHub comments yourself when a finding requires the PR author to make a change. If you are unsure whether something should be posted as a PR comment, keep it in the generated review instead.

Follow the source-aware GitHub action rules in the Cortex City review protocol appended below.`;
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
  termination_reason?: "timeout" | "low_disk";
}

export function resolveReviewOpts(
  config: OrchestratorConfig,
  override?: Partial<SpawnOpts>
): SpawnOpts {
  const configuredRuntime: AgentRuntime =
    config.review_runtime || config.default_agent_runner || "claude";
  const runtime: AgentRuntime =
    override?.runtime || configuredRuntime;
  const usesConfiguredProfile = runtime === configuredRuntime;
  const effort: TaskEffort | undefined =
    override?.effort ??
    (usesConfiguredProfile ? config.review_effort : undefined) ??
    (runtime === "codex" ? config.default_codex_effort : config.default_claude_effort);
  const model =
    override?.model?.trim() ||
    (usesConfiguredProfile ? config.review_model?.trim() : undefined) ||
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

function reviewSourceOf(
  review?: Pick<ReviewRequest, "source">
): ReviewSource {
  return review?.source === "task" ? "task" : "inbound";
}

function normalizedModel(model?: string): string | undefined {
  return model?.trim() || undefined;
}

function snapshotSessionProfile(opts: SpawnOpts): ReviewSessionProfile {
  return {
    runtime: opts.runtime,
    effort: opts.effort,
    model: normalizedModel(opts.model),
  };
}

function savedSessionProfile(
  review?: ReviewSummary
): ReviewSessionProfile | undefined {
  if (!review) return undefined;
  if (review.session_profile) {
    return {
      runtime: review.session_profile.runtime,
      effort: review.session_profile.effort,
      model: normalizedModel(review.session_profile.model),
    };
  }
  // Pre-profile records can still be compared conservatively using the
  // resolved fields that older review runs already persisted.
  if (!review.runtime) return undefined;
  return {
    runtime: review.runtime,
    effort: review.effort,
    model: normalizedModel(review.model),
  };
}

export function isReviewSessionCompatible(
  request: ReviewRequest,
  cached: ReviewSummary | undefined,
  opts: SpawnOpts
): boolean {
  if (!cached?.session_id) return false;
  if (reviewSourceOf(request) !== reviewSourceOf(cached)) return false;
  const saved = savedSessionProfile(cached);
  if (!saved) return false;
  const next = snapshotSessionProfile(opts);
  return (
    saved.runtime === next.runtime &&
    saved.effort === next.effort &&
    saved.model === next.model
  );
}

function effectiveReviewRequest(
  request: ReviewRequest,
  cached?: ReviewSummary
): ReviewRequest {
  const source = request.source ?? cached?.source ?? "inbound";
  if (source !== "task") {
    return {
      ...request,
      source: "inbound",
      task_id: undefined,
      task_title: undefined,
      task_description: undefined,
      task_plan: undefined,
    };
  }
  return {
    ...request,
    source: "task",
    label_only: undefined,
    self_authored: undefined,
    task_id: request.task_id ?? cached?.task_id,
    task_title: request.task_title ?? cached?.task_title,
    task_description: request.task_description ?? cached?.task_description,
    task_plan: request.task_plan ?? cached?.task_plan,
    // These decisions do not apply to a PR owned by the signed-in user.
    my_approval_sha: undefined,
    my_changes_requested_sha: undefined,
  };
}

function reviewRequestSnapshot(review: ReviewRequest): ReviewRequest {
  return {
    source: review.source,
    task_id: review.task_id,
    task_title: review.task_title,
    task_description: review.task_description,
    task_plan: review.task_plan,
    label_only: review.label_only,
    self_authored: review.self_authored,
    pr_url: review.pr_url,
    pr_number: review.pr_number,
    repo_slug: review.repo_slug,
    title: review.title,
    author: review.author,
    head_sha: review.head_sha,
    created_at: review.created_at,
    updated_at: review.updated_at,
    my_last_review_sha: review.my_last_review_sha,
    my_approval_sha: review.my_approval_sha,
    my_changes_requested_sha: review.my_changes_requested_sha,
  };
}

function buildReviewSourceContext(
  request: ReviewRequest,
  taskInstructions?: string
): string[] {
  if (reviewSourceOf(request) !== "task") {
    if (request.self_authored) {
      return [
        "Review source: label-selected self-authored pull request.",
        [
          "The signed-in user owns this PR and opted it into Cortex City review",
          "with the `cortex-city-review` label. Act as an independent reviewer,",
          "but never approve it or request changes on GitHub.",
        ].join(" "),
        [
          "Leave specific, actionable GitHub comments for findings that require",
          "code changes so the PR author can address them.",
        ].join(" "),
      ];
    }
    return [
      "Review source: inbound pull request.",
      "The signed-in user has been asked to review someone else's PR.",
    ];
  }

  const context = [
    "Review source: task-owned pull request.",
    [
      "The signed-in user owns this PR through a Cortex City task. Act as an",
      "independent reviewer, but never approve it or request changes on GitHub.",
    ].join(" "),
    [
      "Leave specific, actionable GitHub comments for every finding that",
      "requires code changes so the implementation agent can address them.",
    ].join(" "),
    [
      "A `ready_for_human_approval` status is only the internal no-blocking-findings",
      "verdict for this shared pipeline. It never authorizes self-approval.",
    ].join(" "),
    "",
    "## Cortex task context",
    `Task ID: ${request.task_id || "(not recorded)"}`,
    "<task_title>",
    request.task_title?.trim() || "(not recorded)",
    "</task_title>",
    "<task_description>",
    request.task_description?.trim() || "(not recorded)",
    "</task_description>",
    "<task_plan>",
    request.task_plan?.trim() || "(not provided)",
    "</task_plan>",
  ];
  if (taskInstructions?.trim()) {
    context.push(
      "",
      "## Additional task-review instructions",
      taskInstructions.trim()
    );
  }
  return context;
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
  const target = effectiveReviewRequest(request, cached);
  const source = reviewSourceOf(target);
  const hasCurrentChangeRequest =
    source === "inbound" &&
    target.my_changes_requested_sha === target.head_sha;
  const base = resolveReviewPrompt(config);
  const reviewedHeadSha = summaryHeadShaFor(cached);
  const followup = isFollowupReview(target, cached);
  const sections = [
    base,
    "",
    "Cortex City review protocol:",
    REVIEW_GITHUB_TOOL_INSTRUCTION,
    ...buildReviewSourceContext(
      target,
      source === "task" ? config.reviewer_agent_prompt : undefined
    ),
    "",
    "- Start the generated review with `## Summary` and put the summary before any findings.",
    [
      "- The `## Summary` must always be a standalone, self-contained description of",
      "the PR in its current state, written for a reader who has not seen any prior",
      "review or summary. Describe what the PR does and your assessment of it as it",
      "stands now. Do not write it as an update or a diff against a previous review:",
      "no references to an earlier summary, to what changed since last time, or to",
      'comments being "addressed", "resolved", or "still unresolved". Any such',
      "follow-up or delta reasoning belongs in your GitHub comments and the agent",
      "status only, never in the summary.",
    ].join(" "),
    "- Then include `## Agent Status` with one exact line: `Agent status: <status>`.",
    `- The status must be one of: ${REVIEW_AGENT_STATUSES.join(", ")}.`,
    source === "task"
      ? [
          "- Use `ready_for_human_approval` as an internal clean-review verdict only",
          "when you have no required code changes and no unresolved blocking issue.",
        ].join(" ")
      : [
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
      `- Start every GitHub comment you post with \`${REVIEWER_GITHUB_COMMENT_PREFIX}\``,
      "as the first characters of the comment body.",
    ].join(" "),
    [
      "- Keep required changes within the PR's stated goal. Establish that goal from",
      "the PR description and the supplied task details for task-owned PRs. A required",
      "finding must identify a defect, regression, safety issue, or missing behavior",
      "that must be fixed for this PR to deliver its stated goal correctly.",
    ].join(" "),
    [
      "- Do not require substantial unrelated redesigns, generalized infrastructure,",
      "optional refactors, stronger guarantees than the task requested, or fixes for",
      "pre-existing problems. Prefer the smallest safe fix for an in-scope finding.",
    ].join(" "),
    [
      "- If a broader improvement is valuable but not required for this PR, you may",
      "leave one explicitly non-blocking top-level GitHub comment that recommends a separate task",
      `and PR. Begin it with \`${REVIEWER_SEPARATE_FOLLOWUP_COMMENT_PREFIX}\`.`,
      "Do not ask for that work to be implemented in the current PR. Such a suggestion",
      "must not by itself produce `needs_author_changes` or `needs_human_decision`.",
    ].join(" "),
    [
      "- The source-aware GitHub action rules below are authoritative and",
      "override any conflicting GitHub-action instruction earlier in the prompt.",
    ].join(" "),
    source === "inbound" && !target.self_authored && !hasCurrentChangeRequest
      ? [
          "- If and only if your final status is `ready_for_human_approval`,",
          "approve the reviewed commit on GitHub before finishing. Use the commit-bound",
          "reviews API with the explicit repository, PR number, and reviewed SHA:",
          "`gh api --method POST repos/<owner>/<repo>/pulls/<number>/reviews",
          "--raw-field event=APPROVE --raw-field commit_id=<reviewed SHA>`.",
          "Never use `gh pr review --approve`, which can approve a newer, unreviewed HEAD.",
          "Immediately before the API call, inspect the signed-in user's latest",
          "submitted decisive review for the reviewed SHA. If it is",
          "`CHANGES_REQUESTED`, do not approve or overwrite it; switch to",
          "`needs_human_decision` and explain the existing human decision.",
        ].join(" ")
      : hasCurrentChangeRequest
        ? [
            "- Do not approve this PR on GitHub. The signed-in user already has a",
            "current `CHANGES_REQUESTED` decision on the reviewed SHA. Do not",
            "overwrite that decision; if your code assessment would otherwise be",
            "clean, use `needs_human_decision` and ask the human to reconcile it.",
          ].join(" ")
      : [
          "- Do not approve this PR on GitHub. It is owned by the signed-in user,",
          "and GitHub does not allow an author to approve their own PR.",
          "If and only if your final status is `ready_for_human_approval`, post a new",
          "top-level PR conversation comment with `gh pr comment <PR URL> --body ...`.",
          "Do not use the review-comment surface for this handoff. Start it with",
          `\`${REVIEWER_SELF_APPROVAL_COMMENT_PREFIX}\` and then use this exact text:`,
          `\`${REVIEWER_SELF_APPROVAL_COMMENT_BODY}\``,
        ].join(" "),
    [
      "- If your final status is `needs_human_decision`, post one GitHub PR",
      "comment that clearly presents the uncertain or advisory points and the",
      "decision the human needs to make. Do this for every review source, including",
      "task-owned and other self-authored PRs. Use the explicit PR URL because",
      "the review workspace is not necessarily a checkout of the target repository.",
      "Use `gh pr comment <PR URL> --body ...`; do not use the review-comment surface.",
      `Start this specific comment with \`${REVIEWER_HUMAN_DECISION_COMMENT_PREFIX}\``,
      "so Cortex City can distinguish it from implementation feedback.",
    ].join(" "),
    [
      "- Include uncertain or advisory points in the generated review as well as",
      "in the required `needs_human_decision` GitHub comment.",
    ].join(" "),
    [
      "- Do not submit a change-request review decision. Do not approve for any",
      "status other than `ready_for_human_approval`, and do not post the human-decision",
      "comment for any status other than `needs_human_decision`.",
    ].join(" "),
    [
      "- Treat every reviewer comment as an immutable timeline event. Never edit or",
      "delete an earlier reviewer comment because a later commit or review reaches a",
      "different result; post a new comment only when the current run requires one.",
    ].join(" "),
    [
      "- Complete the required GitHub action before emitting your final response.",
      "If the action fails and you cannot verify that it succeeded, use `blocked`",
      "and explain the failure in the generated review.",
    ].join(" "),
  ];

  if (followup) {
    sections.push(
      "",
      "This is a follow-up review, not a full re-review.",
      `Previously reviewed head: ${reviewedHeadSha}`,
      `Current head: ${target.head_sha}`,
      [
        "Verify whether your previous findings were addressed. Then review the",
        "changes between the previously reviewed head and the current head for",
        "significant newly introduced issues.",
      ].join(" "),
      [
        "Do not raise new findings about unchanged code unless the issue is critical.",
        "If the previous findings are resolved and the new changes introduce no",
        "significant issues, return a clean status.",
      ].join(" ")
    );
  } else {
    sections.push(
      "",
      "This is an initial review of the current PR state.",
      `Current head SHA: ${target.head_sha}`
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

  sections.push("", `Review this PR: ${target.pr_url}`);
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
  args.push(...buildReviewPermissionArgs("claude"));
  args.push(...buildModelArgsWith("claude", opts.model, opts.effort));
  return args;
}

function buildCodexArgs(
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId?: string
): string[] {
  const args: string[] = ["exec", "--json"];
  args.push(...buildReviewPermissionArgs("codex"));
  if (resumeSessionId) {
    args.push("resume");
  }
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

function killReviewRuntimeProcess(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function spawnRuntime(
  runtime: AgentRuntime,
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId?: string,
  runTimeoutMs = DEFAULT_TASK_RUN_TIMEOUT_MS,
  diskGuardOptions: ReviewDiskGuardOptions = {},
  reviewKey?: string
): SpawnResult {
  const diskGuardContext = `${runtime} review runtime`;
  assertSufficientReviewDiskSpace(
    `launching ${diskGuardContext}`,
    diskGuardOptions
  );

  const command = runtime === "codex" ? "codex" : "claude";
  const args =
    runtime === "codex"
      ? buildCodexArgs(prompt, opts, resumeSessionId)
      : buildClaudeArgs(prompt, opts, resumeSessionId);

  const startedAt = Date.now();
  const workspace = createReviewWorkspace(runtime, reviewKey);
  const workspaceDiskGuardOptions = diskGuardOptions.targetPath
    ? diskGuardOptions
    : { ...diskGuardOptions, targetPath: workspace.path };
  let child: ChildProcess | undefined;
  try {
    if (!diskGuardOptions.targetPath) {
      assertSufficientReviewDiskSpace(
        `launching ${diskGuardContext} workspace`,
        workspaceDiskGuardOptions
      );
    }
    child = spawn(command, args, {
      cwd: workspace.path,
      env: {
        ...buildEnv(),
        TMPDIR: workspace.path,
        TMP: workspace.path,
        TEMP: workspace.path,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // A dedicated process group lets the guard stop commands launched by the
      // reviewer as well as the top-level CLI process.
      detached: process.platform !== "win32",
    });
    markReviewWorkspaceActive(workspace, child.pid);
  } catch (error) {
    if (child) killReviewRuntimeProcess(child, "SIGTERM");
    releaseReviewWorkspaceBeforeStart(workspace);
    throw error;
  }
  if (!child) {
    releaseReviewWorkspaceBeforeStart(workspace);
    throw new Error(`Failed to start ${command}`);
  }
  child.stdin?.end();

  let stdout = "";
  let stderr = "";
  let codexCarry = "";
  const codexResult: CodexEvent[] = [];

  const runtimeDone = new Promise<RunOutput>((resolve) => {
    let settled = false;
    let timedOut = false;
    let lowDiskFailure: LowDiskSpaceError | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let stopDiskMonitor = () => {};

    const finish = (output: RunOutput) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      stopDiskMonitor();
      resolve(output);
    };

    const terminate = () => {
      killReviewRuntimeProcess(child, "SIGTERM");
      forceKillTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killReviewRuntimeProcess(child, "SIGKILL");
        }
      }, 5000);
      forceKillTimeout.unref?.();
    };

    if (typeof runTimeoutMs === "number" && runTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, runTimeoutMs);
      timeout.unref?.();
    }

    const onLowDisk = (error: LowDiskSpaceError) => {
      if (lowDiskFailure) return;
      lowDiskFailure = error;
      terminate();
    };
    const stopDiskMonitors = [
      monitorReviewDiskSpace(
        `the ${diskGuardContext}`,
        onLowDisk,
        diskGuardOptions
      ),
    ];
    if (!diskGuardOptions.targetPath) {
      stopDiskMonitors.push(
        monitorReviewDiskSpace(
          `the ${diskGuardContext} workspace`,
          onLowDisk,
          workspaceDiskGuardOptions
        )
      );
    }
    stopDiskMonitor = () => {
      for (const stop of stopDiskMonitors) stop();
    };

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
      finish({
        result_text: "",
        exit_code: null,
        stderr: stderr + (err.message || String(err)),
        error: lowDiskFailure?.message || err.message || String(err),
        termination_reason: lowDiskFailure ? "low_disk" : undefined,
        duration_ms: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
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
        finish({
          session_id: sessionId,
          result_text: resultText,
          usage,
          duration_ms: duration,
          exit_code: code,
          stderr,
          error: lowDiskFailure?.message || (timedOut
            ? `Run timed out after ${runTimeoutMs}ms`
            : code !== 0
              ? stderr.trim() || `codex exited with code ${code}`
              : undefined),
          termination_reason: lowDiskFailure
            ? "low_disk"
            : timedOut
              ? "timeout"
              : undefined,
        });
        return;
      }

      // Claude — parse JSON from stdout
      try {
        const parsed = JSON.parse(stdout);
        finish({
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
          error: lowDiskFailure?.message || (timedOut
            ? `Run timed out after ${runTimeoutMs}ms`
            : code !== 0 || parsed.is_error
              ? stderr.trim() || `claude exited with code ${code}`
              : undefined),
          termination_reason: lowDiskFailure
            ? "low_disk"
            : timedOut
              ? "timeout"
              : undefined,
        });
      } catch (err) {
        const fallbackError = lowDiskFailure?.message || (timedOut
          ? `Run timed out after ${runTimeoutMs}ms`
          : code !== 0
            ? stderr.trim() || `claude exited with code ${code}`
            : `Failed to parse claude output: ${(err as Error).message}`);
        finish({
          result_text: stdout,
          exit_code: code,
          stderr,
          duration_ms: duration,
          error: fallbackError,
          termination_reason: lowDiskFailure
            ? "low_disk"
            : timedOut
              ? "timeout"
              : undefined,
        });
      }
    });
  });

  const done = runtimeDone.finally(async () => {
    await releaseReviewWorkspace(workspace, child.pid);
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
  const target = effectiveReviewRequest(request, cachedBefore);
  const cachedSummaryHeadSha = summaryHeadShaFor(cachedBefore);
  const followupReview = isFollowupReview(target, cachedBefore);
  const sessionCompatible = isReviewSessionCompatible(
    target,
    cachedBefore,
    opts
  );
  const compatibleCachedSessionId = sessionCompatible
    ? cachedBefore?.session_id
    : undefined;
  const prompt = buildReviewWrapperPrompt(config, target, cachedBefore);
  const resumeSessionId =
    followupReview && compatibleCachedSessionId
      ? compatibleCachedSessionId
      : undefined;
  const baseEntry = {
    ...target,
    summary: cachedBefore?.summary ?? "",
    summary_head_sha: cachedSummaryHeadSha,
    generated_at: cachedBefore?.generated_at ?? "",
    runtime: opts.runtime,
    effort: opts.effort,
    model: opts.model,
    session_profile: snapshotSessionProfile(opts),
    session_id: compatibleCachedSessionId,
    duration_ms: cachedBefore?.duration_ms,
    input_tokens: cachedBefore?.input_tokens,
    output_tokens: cachedBefore?.output_tokens,
    agent_review_status: followupReview
      ? undefined
      : cachedBefore?.agent_review_status,
    followups: cachedBefore?.followups,
    final_at: cachedBefore?.final_at,
    error: cachedBefore?.error,
    error_at: cachedBefore?.error_at,
    ...retroFields(cachedBefore),
  };

  const runLock = await acquireReviewRunLock(target.pr_url);
  let spawned!: SpawnResult;
  try {
    spawned = spawnRuntime(
      opts.runtime,
      prompt,
      opts,
      resumeSessionId,
      runTimeoutMs,
      {},
      target.pr_url
    );
    assertReviewRunLockHealthy(runLock);
    const claimed = await mutateReviewSummary(target.pr_url, (current) => {
      const sameReviewContext = (a: ReviewRequest, b: ReviewRequest) =>
        reviewSourceOf(a) === reviewSourceOf(b) &&
        a.task_id === b.task_id &&
        a.task_title === b.task_title &&
        a.task_description === b.task_description &&
        a.task_plan === b.task_plan;
      const currentMatchesPreparedState = Boolean(
        current &&
          cachedBefore &&
          current.head_sha === cachedBefore.head_sha &&
          sameReviewContext(current, cachedBefore)
      );
      const currentMatchesTarget = Boolean(
        current &&
          current.head_sha === target.head_sha &&
          sameReviewContext(current, target)
      );
      const targetChanged = Boolean(
        current && !currentMatchesPreparedState && !currentMatchesTarget
      );
      if (
        targetChanged ||
        (current?.current_run_pid && isProcessRunning(current.current_run_pid))
      ) {
        return undefined;
      }
      return {
        ...baseEntry,
        // Signals and lifecycle metadata may have changed between discovery
        // and launch. Claim the run under the store lock without reverting
        // those newer fields.
        my_last_review_sha: current
          ? current.my_last_review_sha
          : target.my_last_review_sha,
        my_approval_sha: current
          ? current.my_approval_sha
          : target.my_approval_sha,
        my_changes_requested_sha: current
          ? current.my_changes_requested_sha
          : target.my_changes_requested_sha,
        ...retroFields(current || cachedBefore),
        current_run_pid: spawned.pid,
        current_run_id: runLock.data.token,
      };
    });
    if (!claimed) {
      throw new Error(`Review target changed before launching ${target.pr_url}`);
    }
  } catch (error) {
    if (spawned) killReviewRuntimeProcess(spawned.child, "SIGTERM");
    await releaseReviewRunLock(runLock);
    if (error instanceof LowDiskSpaceError) {
      const failedAt = new Date().toISOString();
      await mutateReviewSummary(target.pr_url, (current) => {
        if (
          current &&
          (current.head_sha !== target.head_sha ||
            (current.current_run_pid && isProcessRunning(current.current_run_pid)))
        ) {
          return undefined;
        }
        return {
          ...baseEntry,
          my_last_review_sha: current
            ? current.my_last_review_sha
            : target.my_last_review_sha,
          my_approval_sha: current
            ? current.my_approval_sha
            : target.my_approval_sha,
          my_changes_requested_sha: current
            ? current.my_changes_requested_sha
            : target.my_changes_requested_sha,
          error: error.message,
          error_at: failedAt,
          current_run_pid: undefined,
          current_run_id: undefined,
          ...retroFields(current || cachedBefore),
        };
      });
    }
    throw error;
  }
  const { pid, child, done } = spawned;

  const completion = done.then(async (output) => {
    let finalOutput = output;
    let resumedSessionFailed = false;
    if (
      output.error &&
      resumeSessionId &&
      output.termination_reason !== "low_disk"
    ) {
      resumedSessionFailed = true;
      const fallbackPrompt = [
        "The previous review session could not be resumed.",
        [
          "Start a fresh session and reconstruct context from GitHub comments,",
          "review threads, and the current PR state.",
        ].join(" "),
        "",
        prompt,
      ].join("\n");
      let fallback: SpawnResult | undefined;
      try {
        fallback = spawnRuntime(
          opts.runtime,
          fallbackPrompt,
          opts,
          undefined,
          runTimeoutMs,
          {},
          target.pr_url
        );
      } catch (error) {
        if (!(error instanceof LowDiskSpaceError)) throw error;
        finalOutput = {
          result_text: "",
          exit_code: null,
          stderr: "",
          error: error.message,
          termination_reason: "low_disk",
        };
      }
      if (fallback) {
        assertReviewRunLockHealthy(runLock);
        await patchReviewSummary(target.pr_url, {
          current_run_pid: fallback.pid,
          current_run_id: runLock.data.token,
        });
        finalOutput = await fallback.done;
      }
    }

    const generatedAt = new Date().toISOString();
    const successful = !finalOutput.error;
    assertReviewRunLockHealthy(runLock);
    const saved = await mutateReviewSummary(target.pr_url, (latestBeforeSave) => {
      if (latestBeforeSave?.current_run_id !== runLock.data.token) {
        return undefined;
      }
      const latestTarget = effectiveReviewRequest(
        reviewRequestSnapshot(latestBeforeSave),
        latestBeforeSave
      );
      const headMovedDuringRun = latestTarget.head_sha !== target.head_sha;
      const reviewContextChangedDuringRun =
        reviewSourceOf(latestTarget) !== reviewSourceOf(target) ||
        latestTarget.task_id !== target.task_id ||
        latestTarget.task_title !== target.task_title ||
        latestTarget.task_description !== target.task_description ||
        latestTarget.task_plan !== target.task_plan;
      return {
        // Reconciliation may discover a new HEAD or change review context while
        // the agent is running. Keep the latest identity; a changed context is
        // invalidated so the next poll reruns under the right policy.
        ...latestTarget,
        summary: reviewContextChangedDuringRun
          ? ""
          : successful
            ? finalOutput.result_text.trim()
            : latestBeforeSave.summary,
        summary_head_sha: reviewContextChangedDuringRun
          ? undefined
          : successful
            ? target.head_sha
            : summaryHeadShaFor(latestBeforeSave),
        generated_at: reviewContextChangedDuringRun
          ? ""
          : successful
            ? generatedAt
            : latestBeforeSave.generated_at,
        runtime: opts.runtime,
        effort: opts.effort,
        model: opts.model,
        session_profile: snapshotSessionProfile(opts),
        session_id:
          (reviewContextChangedDuringRun
            ? undefined
            : finalOutput.session_id ||
              (successful
                ? resumeSessionId
                : resumedSessionFailed
                  ? undefined
                  : compatibleCachedSessionId)) || undefined,
        duration_ms: finalOutput.duration_ms,
        input_tokens: finalOutput.usage?.input_tokens,
        output_tokens: finalOutput.usage?.output_tokens,
        error: reviewContextChangedDuringRun ? undefined : finalOutput.error,
        error_at:
          reviewContextChangedDuringRun || successful ? undefined : generatedAt,
        agent_review_status: successful
          ? headMovedDuringRun || reviewContextChangedDuringRun
            ? undefined
            : parseReviewAgentStatus(finalOutput.result_text)
          : latestBeforeSave.agent_review_status,
        followups: reviewContextChangedDuringRun
          ? []
          : followupReview || finalOutput.error
            ? latestBeforeSave.followups || []
            : [],
        // Review signals are owned by the worker poll and the submit route,
        // which may update them while this run is in flight. This mutation
        // executes under the store's cross-process lock, so it merges the
        // newest persisted signals and verifies ownership in one step.
        my_last_review_sha: latestBeforeSave.my_last_review_sha,
        my_approval_sha: latestBeforeSave.my_approval_sha,
        my_changes_requested_sha: latestBeforeSave.my_changes_requested_sha,
        final_at: undefined,
        current_run_pid: undefined,
        current_run_id: undefined,
        ...retroFields(latestBeforeSave),
      };
    });
    if (!saved) {
      throw new Error(
        `Review run ownership was lost before saving ${target.pr_url}`
      );
    }
    if (onComplete) {
      await onComplete(saved);
    }
    return saved;
  }).finally(async () => {
    await releaseReviewRunLock(runLock);
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
  const opts: SpawnOpts = cached.session_profile
    ? snapshotSessionProfile(cached.session_profile)
    : resolveReviewOpts(config, {
        runtime: cached.runtime,
        effort: cached.effort,
        model: cached.model,
      });
  const profile = snapshotSessionProfile(opts);
  const canResume = isReviewSessionCompatible(cached, cached, opts);

  const askedAt = new Date().toISOString();
  const failedFollowup = (
    error: string,
    resumed: boolean
  ): ReviewFollowup => ({
    asked_at: askedAt,
    question,
    answered_at: new Date().toISOString(),
    answer: "",
    session_profile: profile,
    resumed,
    error,
  });
  const isSummaryStale =
    Boolean(cached.summary_head_sha) && cached.summary_head_sha !== cached.head_sha;
  const followupPrompt = [
    ...buildReviewSourceContext(
      cached,
      reviewSourceOf(cached) === "task"
        ? config.reviewer_agent_prompt
        : undefined
    ),
    "",
    REVIEW_GITHUB_TOOL_INSTRUCTION,
    `PR URL: ${prUrl}`,
    isSummaryStale
      ? `The cached summary was generated for ${cached.summary_head_sha}, but the current head is ${cached.head_sha}. Answer against the current PR state when the latest code matters.`
      : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (canResume && cached.session_id) {
    let resumed: SpawnResult;
    try {
      resumed = spawnRuntime(
        opts.runtime,
        followupPrompt,
        opts,
        cached.session_id,
        runTimeoutMs,
        {},
        prUrl
      );
    } catch (error) {
      if (error instanceof LowDiskSpaceError) {
        return failedFollowup(error.message, true);
      }
      throw error;
    }
    const result = await resumed.done;
    if (!result.error && result.result_text.trim()) {
      return {
        asked_at: askedAt,
        question,
        answered_at: new Date().toISOString(),
        answer: result.result_text.trim(),
        session_id: result.session_id || cached.session_id,
        session_profile: profile,
        resumed: true,
      };
    }
    if (result.termination_reason === "low_disk") {
      return failedFollowup(result.error || "Review stopped due to low disk space.", true);
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
    REVIEW_GITHUB_TOOL_INSTRUCTION,
    ...buildReviewSourceContext(
      cached,
      reviewSourceOf(cached) === "task"
        ? config.reviewer_agent_prompt
        : undefined
    ),
    "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  let fresh: SpawnResult;
  try {
    fresh = spawnRuntime(
      opts.runtime,
      seededPrompt,
      opts,
      undefined,
      runTimeoutMs,
      {},
      prUrl
    );
  } catch (error) {
    if (error instanceof LowDiskSpaceError) {
      return failedFollowup(error.message, false);
    }
    throw error;
  }
  const result = await fresh.done;
  return {
    asked_at: askedAt,
    question,
    answered_at: new Date().toISOString(),
    answer: (result.result_text || "").trim(),
    session_id: result.session_id,
    session_profile: profile,
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
  const profile = followup.session_profile;
  return patchReviewSummary(prUrl, {
    followups,
    ...(followup.session_id && profile
      ? {
          session_id: followup.session_id,
          session_profile: profile,
          runtime: profile.runtime,
          effort: profile.effort,
          model: profile.model,
        }
      : {}),
  });
}
