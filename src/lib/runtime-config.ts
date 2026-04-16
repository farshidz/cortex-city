import type {
  AgentRuntime,
  ClaudeEffort,
  CodexEffort,
  OrchestratorConfig,
  PermissionMode,
  Task,
  TaskEffort,
} from "./types";

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

const CLAUDE_PERMISSION_OPTIONS: SelectOption<PermissionMode>[] = [
  {
    value: "bypassPermissions",
    label: "Bypass Permissions (fully autonomous)",
  },
  {
    value: "acceptEdits",
    label: "Accept Edits (auto-approve edits, prompt for bash)",
  },
  {
    value: "default",
    label: "Default (prompt for everything)",
  },
];

const CODEX_PERMISSION_OPTIONS: SelectOption<PermissionMode>[] = [
  {
    value: "default",
    label: "Prompt for every action",
  },
  {
    value: "yolo",
    label: "YOLO (no prompts, full autonomy)",
  },
];

const CLAUDE_EFFORT_OPTIONS: SelectOption<ClaudeEffort>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const CODEX_EFFORT_OPTIONS: SelectOption<CodexEffort>[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export function getPermissionOptions(runtime: AgentRuntime): SelectOption<PermissionMode>[] {
  return runtime === "codex" ? CODEX_PERMISSION_OPTIONS : CLAUDE_PERMISSION_OPTIONS;
}

export function normalizePermissionMode(
  runtime: AgentRuntime,
  mode?: PermissionMode,
  fallback?: PermissionMode
): PermissionMode {
  const allowed = getPermissionOptions(runtime).map((option) => option.value);
  if (mode && allowed.includes(mode)) return mode;
  if (fallback && allowed.includes(fallback)) return fallback;
  return allowed[0];
}

export function getEffortOptions(runtime: AgentRuntime): SelectOption<TaskEffort>[] {
  return runtime === "codex"
    ? [...CODEX_EFFORT_OPTIONS]
    : [...CLAUDE_EFFORT_OPTIONS];
}

export function getDefaultModelForRuntime(
  config: OrchestratorConfig,
  runtime: AgentRuntime
): string {
  const value =
    runtime === "codex"
      ? config.default_codex_model
      : config.default_claude_model;
  return value?.trim() || "";
}

export function getDefaultEffortForRuntime(
  config: OrchestratorConfig,
  runtime: AgentRuntime
): TaskEffort | undefined {
  return runtime === "codex"
    ? config.default_codex_effort
    : config.default_claude_effort;
}

export function normalizeModel(model?: string, fallback?: string): string | undefined {
  const value = model?.trim();
  if (value) return value;
  const fallbackValue = fallback?.trim();
  return fallbackValue || undefined;
}

export function normalizeEffort(
  runtime: AgentRuntime,
  effort?: string,
  config?: OrchestratorConfig
): TaskEffort | undefined {
  const allowed = getEffortOptions(runtime).map((option) => option.value);
  if (effort && allowed.includes(effort as TaskEffort)) {
    return effort as TaskEffort;
  }
  const fallback = config ? getDefaultEffortForRuntime(config, runtime) : undefined;
  if (fallback && allowed.includes(fallback)) {
    return fallback;
  }
  return undefined;
}

export function resolveTaskRuntime(
  task: Pick<Task, "agent_runner">,
  config: OrchestratorConfig
): AgentRuntime {
  return task.agent_runner || config.default_agent_runner || "claude";
}

export function resolveTaskModel(
  task: Pick<Task, "agent_runner" | "model">,
  config: OrchestratorConfig
): string | undefined {
  const runtime = resolveTaskRuntime(task, config);
  return normalizeModel(task.model, getDefaultModelForRuntime(config, runtime));
}

export function resolveTaskEffort(
  task: Pick<Task, "agent_runner" | "effort">,
  config: OrchestratorConfig
): TaskEffort | undefined {
  const runtime = resolveTaskRuntime(task, config);
  return normalizeEffort(runtime, task.effort, config);
}

export function formatEffortLabel(effort?: string): string {
  if (!effort) return "CLI default";
  if (effort === "xhigh") return "Extra High";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
