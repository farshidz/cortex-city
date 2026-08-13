export type TaskStatus = "open" | "in_progress" | "in_review" | "merged" | "closed";

export type IssueStatus = "open" | "in_progress" | "done" | "closed";

export type IssuePriority = "low" | "medium" | "high";

export interface IssueComment {
  id: string;
  body: string;
  created_at: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  plan?: string;
  status: IssueStatus;
  priority?: IssuePriority;
  task_id?: string;
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
}

export interface LinkedTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface LinkedIssueSummary {
  id: string;
  title: string;
  status: IssueStatus;
}

export interface AgentReport {
  status: "completed" | "needs_review" | "blocked" | "failed";
  summary: string;
  pr_url?: string;
  branch_name?: string;
  stacked_prs?: AgentReportStackedPR[];
  files_changed: string[];
  assumptions: string[];
  blockers: string[];
  next_steps: string[];
  tool_calls?: AgentToolCalls;
}

// Stack membership as the agent reports it. Lifecycle state stays out of the
// report: the worker owns entry states by polling GitHub directly.
export interface AgentReportStackedPR {
  position: number; // 1 = bottom PR targeting the agent's base branch
  pr_url: string;
  branch_name: string;
  base_branch: string;
  scope: string;
}

export type TaskStackedPRState = "open" | "merged" | "closed";

export interface TaskStackedPR {
  position: number; // 1 = bottom of the stack
  pr_url: string;
  branch_name: string;
  base_branch: string;
  scope: string;
  state: TaskStackedPRState;
  // Set while an implementation run has observed the PR but its final
  // structured report has not confirmed stack membership yet.
  provisional?: boolean;
  pr_status?: PRStatus;
  // Per-PR analog of Task.last_review_gh_state; stacked tasks track review
  // wakeup hashes per entry instead of on the task.
  last_review_gh_state?: string;
  // Recorded when the worker observes this entry merge (worker-owned).
  merge_commit_sha?: string;
  // Merge commits of lower entries whose incorporation into this open entry's
  // history GitHub has not yet verified. While non-empty the restack stays
  // required, no matter what base the agent report claims (worker-owned).
  pending_restack_of?: string[];
}

export interface AgentToolCalls {
  create_task?: FollowupTaskRequest[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  plan?: string;
  status: TaskStatus;
  agent: string; // key from config.agents
  agent_runner?: AgentRuntime;
  permission_mode?: PermissionMode;
  reviewer_agent_enabled?: boolean;
  model?: string;
  effort?: TaskEffort;
  parent_task_id?: string;
  child_tasks?: ChildTaskSummary[];
  created_at: string; // ISO 8601
  updated_at: string;

  // Orchestration metadata
  paused?: boolean; // when true, the worker skips this task during polls
  session_id?: string;
  pr_url?: string;
  // Mirrors the provisional state of a live-discovered pr_url. Completion
  // clears or confirms it from the final structured report.
  pr_url_provisional?: boolean;
  branch_name?: string;
  // Present only when the task produced a stack of PRs. pr_url/branch_name
  // then mirror the bottom-most open entry so single-PR consumers keep
  // pointing at the currently mergeable PR.
  stacked_prs?: TaskStackedPR[];
  worktree_path?: string;
  final_cleanup_state?: "running" | "finished";
  current_run_pid?: number;
  current_run_mode?: TaskRunMode;
  resume_requested?: boolean;
  resume_run_mode?: ResumableTaskRunMode;
  pending_manual_instruction?: string;
  last_run_at?: string;
  last_run_result?: "success" | "error" | "timeout" | "budget_exceeded";
  last_run_input_tokens?: number;
  last_run_cached_input_tokens?: number;
  last_run_output_tokens?: number;
  total_input_tokens?: number;
  total_cached_input_tokens?: number;
  total_output_tokens?: number;
  total_duration_ms?: number;
  run_count?: number;
  error_log?: string;
  last_agent_report?: AgentReport;
  codex_usage_session_id?: string;
  codex_cumulative_input_tokens?: number;
  codex_cumulative_cached_input_tokens?: number;
  codex_cumulative_output_tokens?: number;
  // Fingerprint of the broken-stack condition (closed unmerged base) whose
  // decision run was last launched. The worker stops re-forcing decision runs
  // only while this matches the current condition AND a blocked report is
  // recorded, so an unrelated blocker or a different later closure cannot
  // suppress surfacing.
  stack_decision_requested?: string;
  // Review tracking
  last_review_gh_state?: string; // hash of PR state captured after each run
  // Rollout marker for a head already covered by the retired task reviewer.
  // The unified reviewer takes over after the PR moves to a new head.
  review_migration_head_sha?: string;
  pr_status?: "clean" | "checks_failing" | "checks_pending" | "needs_approval" | "conflicts" | "unstable" | "unknown";
  notes?: string;
  issue_id?: string;
}

export interface AgentConfig {
  name: string;
  repo_slug: string; // e.g. "owner/repo" (for GitHub API / display)
  repo_path?: string; // legacy absolute path field; ignored by the runner
  working_directory?: string; // relative path inside the repo; defaults to repo root
  prompt_file: string; // relative path to agent's prompt file
  review_prompt_file?: string; // optional relative path to review-specific prompt file
  cleanup_prompt_file?: string; // optional relative path to cleanup-specific prompt file
  default_branch: string;
  git_user_name?: string; // optional per-agent Git author name
  git_user_email?: string; // optional per-agent Git author email
  env_file?: string; // optional path to .env file with agent-specific secrets
  description?: string;
}

export type PromptMode = "initial" | "review" | "cleanup";

export type TaskRunMode = "initial" | "review" | "cleanup";

export type ResumableTaskRunMode = Exclude<TaskRunMode, "cleanup">;

export type AgentRuntime = "claude" | "codex";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CodexEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type TaskEffort = ClaudeEffort | CodexEffort;

export type PermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "auto"
  | "default"
  | "yolo";

// Which reviewer configuration a round runs on. Tier 2 is the full reviewer:
// discovery, escalations, and the pass that may declare a PR ready. Tier 1 is
// the cheap verification configuration and can never produce a terminal
// verdict. Tiering is off unless `reviewer_tiers.tier1` is configured.
export type ReviewTier = 1 | 2;

export interface ReviewerTierConfig {
  runtime?: AgentRuntime;
  model?: string;
  effort?: TaskEffort;
}

export interface ReviewerTiers {
  tier1?: ReviewerTierConfig;
  tier2?: ReviewerTierConfig;
}

export interface OrchestratorConfig {
  max_parallel_sessions: number;
  poll_interval_seconds: number;
  task_run_timeout_ms?: number;
  default_permission_mode: PermissionMode;
  default_agent_runner: AgentRuntime;
  default_claude_model?: string;
  default_claude_effort?: ClaudeEffort;
  default_codex_model?: string;
  default_codex_effort?: CodexEffort;
  agents: Record<string, AgentConfig>;
  review_prompt?: string;
  reviewer_agent_prompt?: string;
  review_runtime?: AgentRuntime;
  review_effort?: TaskEffort;
  review_model?: string;
  max_parallel_reviews?: number;
  reviewer_tiers?: ReviewerTiers;
  review_learning_enabled?: boolean;
  // How long a PR head must sit still before a changed effective diff schedules
  // a review round. Absent falls back to REVIEW_DEBOUNCE_DEFAULT_SECONDS; 0
  // disables the wait.
  review_debounce_seconds?: number;
  worktree_roots?: string[];
}

export type PRStatus =
  | "clean"
  | "checks_failing"
  | "checks_pending"
  | "needs_approval"
  | "conflicts"
  | "unstable"
  | "unknown";

export type ReviewSource = "inbound" | "task";

export interface ReviewRequest {
  // Omitted by legacy callers/records. The review store normalizes an omitted
  // or unknown source to "inbound" so existing review data remains safe.
  source?: ReviewSource;
  // Task linkage is populated only for Cortex-owned PRs. Keeping the task goal
  // beside the review target lets the shared reviewer assess implementation
  // completeness without coupling review execution back to the task runner.
  task_id?: string;
  task_title?: string;
  task_description?: string;
  task_plan?: string;
  // Stack slice context, populated only when the reviewed PR belongs to a
  // task-owned stack. The reviewer judges the PR against its slice scope
  // instead of the whole task.
  task_stack_position?: number;
  task_stack_size?: number;
  task_pr_scope?: string;
  // True when the label was the only discovery criterion that selected this
  // PR. Removing the label can then retire the review without treating an open
  // PR as a failed final-state lookup.
  label_only?: boolean;
  // Self-authored labeled PRs are reviewable by the agent, but GitHub does not
  // allow their owner to approve or request changes on them.
  self_authored?: boolean;
  pr_url: string;
  pr_number: number;
  repo_slug: string;
  title: string;
  author: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  // SHA of the most recent review the signed-in user submitted on this PR.
  // Undefined if the user has never reviewed.
  my_last_review_sha?: string;
  // SHA at which the signed-in user's current decision review is an APPROVAL.
  // Undefined unless the user's latest non-comment review is an approval. The
  // reviewer agent may set this when it confidently approves an inbound PR;
  // the human may also approve directly. Compared against head_sha so a stale
  // approval (from before new commits) does not count.
  my_approval_sha?: string;
  // Symmetric to my_approval_sha: SHA at which the signed-in user's current
  // decision review is a CHANGES_REQUESTED. Lets a human change request
  // supersede a stale agent verdict. Compared against head_sha so a request
  // from before new commits does not count.
  my_changes_requested_sha?: string;
}

export type ReviewStatus =
  | "needs_review"
  | "new_commits"
  | "up_to_date"
  | "pending_summary"
  | "summarizing"
  | "summary_error"
  | "final";

export type ReviewAgentStatus =
  | "ready_for_human_approval"
  | "needs_author_changes"
  | "needs_human_decision"
  | "blocked";

export interface ReviewSessionProfile {
  runtime: AgentRuntime;
  effort?: TaskEffort;
  model?: string;
  // The tier this profile was resolved for. Absent on rows written before
  // tiering, and on runs made while tiering is disabled.
  tier?: ReviewTier;
}

// What a tier-1 verification round is allowed to report. `fixes_verified` and
// `escalate` both hand the PR to a tier-2 round; neither is terminal.
export type ReviewTier1Status =
  | "fixes_verified"
  | "needs_author_changes"
  | "escalate";

// Why a completed round handed its diff to a tier-2 pass instead of settling it.
// `fixes_verified` and `escalate` come from a tier-1 verification round;
// `conversation_resolved` comes from a reply round whose conversation settled the
// standing verdict. All three mean the same thing to scheduling: the recorded
// verdict no longer describes this diff, and only a tier-2 round may replace it.
export type ReviewPendingTier2Reason =
  | "fixes_verified"
  | "escalate"
  | "conversation_resolved";

// One unresolved reviewer-authored review thread, listed mechanically by the
// orchestrator so a tier-1 round starts from pointers instead of a transcript.
export interface ReviewerThreadSummary {
  thread_id: string;
  url?: string;
  first_line: string;
}

export type ReviewerCommentKind = "human_decision" | "manual_approval";

export interface ReviewerCommentDelivery {
  // Generated by Cortex City and persisted before the first GitHub POST. The
  // token makes an interrupted POST recoverable without mutating the timeline.
  action_token: string;
  kind: ReviewerCommentKind;
  head_sha: string;
  body: string;
}

// Which GitHub comment collection a receipted comment lives in. IDs are only
// unique per surface, so a receipt is meaningless without it. Legacy receipts
// predate inline review comments and are all "issue" (PR conversation).
export type ReviewerCommentSurface = "issue" | "review_comment";

export interface ReviewerCommentReceipt {
  // Set only for the two application-owned delivery actions (human decision,
  // manual-approval handoff). A receipt is stored for those only after GitHub
  // returns a comment whose author and immutable body match the durable action
  // exactly. Reviewer-authored comments posted by the run itself have no
  // action token: they are recognized by author plus the reviewer prefix.
  action_token?: string;
  comment_id: number;
  author_login: string;
  body_sha256: string;
  // Defaults to "issue" when absent.
  surface?: ReviewerCommentSurface;
}

export interface ReviewerCommentCancellation {
  // An undelivered action is retained as an explicit terminal ledger entry
  // when GitHub proves that its reviewed SHA or open-PR target is stale.
  action_token: string;
  reason: "head_changed" | "pr_not_open";
  expected_head_sha: string;
  observed_head_sha?: string;
  observed_pr_state: string;
  body_sha256: string;
  canceled_at: string;
}

// Single backend-derived state that merges the pipeline/freshness axis
// (ReviewStatus) with the agent verdict axis (ReviewAgentStatus). The verdict
// wins whenever it is present; otherwise the pipeline/freshness state shows.
// The frontend reads only this field and does no state derivation of its own.
export type ReviewState =
  | "archived" // final_at set
  | "generating" // a review run is in progress (current_run_pid set)
  | "generation_failed" // error set
  | "queued" // no summary yet, no active run, no error
  | "re_reviewing" // summary stale vs HEAD (new commits; verdict already cleared)
  | "blocked" // verdict: agent could not complete the review
  | "needs_author_changes" // verdict: agent found required changes
  | "needs_decision" // verdict: agent flagged advisory/uncertain points for you
  | "ready_to_approve" // verdict: agent found nothing blocking
  | "approved" // the reviewer or user approved this HEAD (overrides the verdict)
  | "changes_requested" // you requested changes on this HEAD (overrides the verdict)
  | "reviewed" // no verdict, summary current, you've reviewed this HEAD
  | "needs_review"; // no verdict, summary current, you haven't reviewed (fallback)

export interface ReviewSummary extends ReviewRequest {
  summary: string;
  summary_head_sha?: string;
  // Identity of the effective diff (base...head) the stored summary reviewed.
  // Scheduling compares this against `effective_diff_hash`, so a rebase that
  // leaves the diff intact is not a new review round.
  summary_diff_hash?: string;
  // Identity of the effective diff at `effective_diff_head_sha`, which is the
  // head it was computed from. Both are absent when GitHub could not answer,
  // and scheduling then falls back to comparing head SHAs.
  effective_diff_hash?: string;
  effective_diff_head_sha?: string;
  // When the worker first observed the current `head_sha`. Anchors the review
  // debounce window; stacked PRs share the newest value in their stack.
  head_first_seen_at?: string;
  // Everything a completed round had already seen: comments by anyone other
  // than the reviewer created at or before this instant do not trigger a reply
  // round.
  last_conversation_seen_at?: string;
  // Effective diff the most recent completed round of any tier covered. A tier-1
  // verification round advances this without rewriting the summary, so the same
  // diff is not verified twice.
  last_round_diff_hash?: string;
  // Head that round covered. Used only when no diff identity is available, so a
  // tier-1 round at a PR whose diff GitHub could not identify still counts as
  // covering the current head instead of repeating forever.
  last_round_head_sha?: string;
  // Set by a round that cannot conclude on its own: a tier-1 verification round,
  // or a reply round that reports the standing verdict settled. The next round is
  // a tier-2 pass at the same diff; a terminal verdict never comes from either.
  pending_tier2_reason?: ReviewPendingTier2Reason;
  generated_at: string;
  review_status: ReviewStatus;
  review_state: ReviewState;
  runtime?: AgentRuntime;
  effort?: TaskEffort;
  model?: string;
  // Presence means the complete resolved profile was snapshotted, including
  // intentional undefined model/effort values that defer to the CLI.
  session_profile?: ReviewSessionProfile;
  session_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
  error_at?: string;
  agent_review_status?: ReviewAgentStatus;
  // Comments the reviewer posted, recorded per surface. These IDs are filtered
  // from task wakeups and PR-state hashes. Receipts for the two
  // application-owned handoff comments are verified immutable events, matched by
  // author and exact body against a durable action token. Receipts the reviewer
  // run itself produced are matched by author plus the public reviewer prefix,
  // which is weaker: on a self-authored PR the human author shares the
  // reviewer's login, so a human comment starting with that prefix is treated as
  // reviewer-authored. See README.md for that accepted residual risk.
  reviewer_comment_receipts?: ReviewerCommentReceipt[];
  // Terminal records for actions GitHub proved stale before any POST. These
  // tokens must never be retried or treated as delivered timeline events.
  reviewer_comment_cancellations?: ReviewerCommentCancellation[];
  // The complete action is durably saved before POST. It remains pending until
  // its verified receipt and the enclosing review result have both been saved.
  pending_reviewer_comment_delivery?: ReviewerCommentDelivery;
  // An unsubmitted (GitHub PENDING) review on this PR that Cortex City could not
  // repair. Two classes: content it did not author — a comment or a review body
  // without the reviewer prefix, which on a shared login includes the human's own
  // draft — and a failed repair call, whether listing the held comments, deleting
  // an empty draft, or submitting an owned one. While it stands, every reviewer
  // comment on this PR is captured by it and visible to nobody else, so the
  // condition is recorded rather than left to be inferred from missing comments.
  // The worker poll retries the repair for as long as this is set, because a
  // PENDING review is excluded from the PR state hash and so cannot schedule a
  // round of its own.
  pending_review_error?: string;
  followups?: ReviewFollowup[];
  final_at?: string;
  final_state?: "merged" | "closed";
  final_state_lookup_started_at?: string;
  final_state_lookup_error_started_at?: string;
  final_state_lookup_error?: string;
  retro_status?: "pending" | "done" | "error";
  retro_done_at?: string;
  retro_run_pid?: number;
  retro_error?: string;
  current_run_pid?: number;
  current_run_id?: string;
}

export interface ReviewFollowup {
  asked_at: string;
  question: string;
  answered_at: string;
  answer: string;
  session_id?: string;
  session_profile?: ReviewSessionProfile;
  resumed: boolean;
  error?: string;
}

export interface FollowupTaskRequest {
  title: string;
  description: string;
  agent: string;
  plan?: string;
}

export interface ChildTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  agent: string;
}

export interface ActiveSession {
  kind: "task" | "review";
  run_kind?: "review" | "review_retro";
  // For tasks this is the task id; for reviews it's the PR URL (used as the
  // stable key in .cortex/reviews.json).
  task_id: string;
  task_title: string;
  agent: string;
  session_id: string;
  pid: number;
  started_at: string;
  status: "running" | "completing";
}

export interface OrchestratorStatus {
  running: boolean;
  healthy: boolean;
  worker_healthy: boolean;
  autostart_enabled: boolean;
  active_sessions: number;
  max_sessions: number;
  last_poll_at: string | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
  poll_started_at: string | null;
  poll_finished_at: string | null;
  poll_in_progress: boolean;
}

export type AgentQuotaState = "available" | "unavailable" | "error";

export interface AgentQuotaStatus {
  runtime: AgentRuntime;
  state: AgentQuotaState;
  fetched_at: string;
  quota?: Record<string, unknown>;
  message?: string;
}

export interface ClaudeRunResult {
  type: string;
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  result: string;
  session_id: string;
  terminal_reason: string;
  total_cost_usd: number;
  num_turns: number;
  structured_output?: AgentReport;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}
