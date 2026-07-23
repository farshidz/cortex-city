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
  files_changed: string[];
  assumptions: string[];
  blockers: string[];
  next_steps: string[];
  tool_calls?: AgentToolCalls;
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
  branch_name?: string;
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
  review_learning_enabled?: boolean;
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
  // Exact top-level PR conversation comments emitted for human decisions or
  // self-approval handoffs. Tracking IDs avoids trusting a public body prefix
  // when task feedback is filtered and remains valid across later review heads.
  reviewer_human_decision_comment_ids?: number[];
  // Token and exact receipt for the currently active reviewer-owned PR comment.
  // Retaining both after a successful run lets a later review safely update or
  // remove the prompt without adopting marker-shaped participant content.
  active_reviewer_owned_comment_token?: string;
  active_reviewer_owned_comment_id?: number;
  // Persisted before any application-owned comment action and never exposed to
  // the model. If the process dies after posting but before saving the receipt,
  // this token identifies the one comment that must be reconciled on retry.
  pending_reviewer_human_decision_comment_token?: string;
  // Exact receipt pinned to the pending token before any later edit or delete.
  // Destructive reconciliation must never fall back to a marker-only match.
  pending_reviewer_human_decision_comment_id?: number;
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
