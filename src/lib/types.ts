export type TaskStatus = "open" | "in_progress" | "in_review" | "merged" | "closed";

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
  model?: string;
  effort?: TaskEffort;
  parent_task_id?: string;
  child_tasks?: ChildTaskSummary[];
  created_at: string; // ISO 8601
  updated_at: string;

  // Orchestration metadata
  session_id?: string;
  pr_url?: string;
  branch_name?: string;
  worktree_path?: string;
  current_run_pid?: number;
  resume_requested?: boolean;
  pending_manual_instruction?: string;
  last_run_at?: string;
  last_run_result?: "success" | "error" | "timeout" | "budget_exceeded";
  last_run_input_tokens?: number;
  last_run_output_tokens?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_duration_ms?: number;
  run_count?: number;
  error_log?: string;
  last_agent_report?: AgentReport;
  // Review tracking
  last_review_gh_state?: string; // hash of PR state captured after each run
  pr_status?: "clean" | "checks_failing" | "checks_pending" | "needs_approval" | "conflicts" | "unstable" | "unknown";
  notes?: string;
}

export interface AgentConfig {
  name: string;
  repo_slug: string; // e.g. "owner/repo" (for GitHub API / display)
  repo_path: string; // absolute path to local repo clone
  prompt_file: string; // relative path to agent's prompt file
  review_prompt_file?: string; // optional relative path to review-specific prompt file
  cleanup_prompt_file?: string; // optional relative path to cleanup-specific prompt file
  default_branch: string;
  env_file?: string; // optional path to .env file with agent-specific secrets
  description?: string;
}

export type PromptMode = "initial" | "review" | "cleanup";

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
  default_permission_mode: PermissionMode;
  default_agent_runner: AgentRuntime;
  default_claude_model?: string;
  default_claude_effort?: ClaudeEffort;
  default_codex_model?: string;
  default_codex_effort?: CodexEffort;
  agents: Record<string, AgentConfig>;
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
  supervisor_healthy: boolean;
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
