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
  session_id?: string;
  reviewer_session_id?: string;
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
  reviewer_codex_usage_session_id?: string;
  reviewer_codex_cumulative_input_tokens?: number;
  reviewer_codex_cumulative_cached_input_tokens?: number;
  reviewer_codex_cumulative_output_tokens?: number;
  // Review tracking
  reviewer_run_pending?: boolean;
  reviewer_last_reviewed_head_sha?: string;
  last_review_gh_state?: string; // hash of PR state captured after each run
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

export type TaskRunMode = "initial" | "review" | "reviewer" | "cleanup";

export type ResumableTaskRunMode = Exclude<TaskRunMode, "cleanup">;

export type AgentRuntime = "claude" | "codex";

export type ClaudeEffort = "low" | "medium" | "high" | "max";

export type CodexEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type TaskEffort = ClaudeEffort | CodexEffort;

export type PermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
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
}

export type PRStatus =
  | "clean"
  | "checks_failing"
  | "checks_pending"
  | "needs_approval"
  | "conflicts"
  | "unstable"
  | "unknown";

export interface ReviewRequest {
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
}

export type ReviewStatus =
  | "needs_review"
  | "new_commits"
  | "up_to_date"
  | "pending_summary"
  | "summarizing"
  | "summary_error"
  | "final";

export interface ReviewSummary extends ReviewRequest {
  summary: string;
  summary_head_sha?: string;
  generated_at: string;
  review_status: ReviewStatus;
  runtime?: AgentRuntime;
  effort?: TaskEffort;
  model?: string;
  session_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
  followups?: ReviewFollowup[];
  final_at?: string;
  current_run_pid?: number;
}

export interface ReviewFollowup {
  asked_at: string;
  question: string;
  answered_at: string;
  answer: string;
  session_id?: string;
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
