import { readFileSync } from "fs";
import path from "path";
import type { Task, AgentConfig, OrchestratorConfig } from "./types";
import { readConfig } from "./store";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

interface ReviewPromptOptions {
  prStatus?: string;
  baseBranch?: string;
}

function loadTemplate(name: string): string {
  return readFileSync(path.join(PROMPTS_DIR, "templates", name), "utf-8");
}

function loadAgentPrompt(promptFile: string): string {
  try {
    return readFileSync(path.join(process.cwd(), promptFile), "utf-8");
  } catch {
    return "No agent-specific context available.";
  }
}

export function buildInitialPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("initial.md");
  const repoContext = agentConfig
    ? loadAgentPrompt(agentConfig.prompt_file)
    : "No agent-specific context configured.";

  const agentName = agentConfig?.name || task.agent;
  const agentDirectory = buildAgentDirectory(config, task.agent);

  const prompt = template
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace(
      "{{TASK_PLAN}}",
      task.plan || "No detailed plan provided. Determine the best approach."
    )
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{REPO_CONTEXT}}", repoContext)
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);

  return appendManualInstruction(prompt, task);
}

function describeMergeStatus(status?: string): string {
  switch (status) {
    case "conflicts":
      return "GitHub reports merge conflicts with the base branch. Resolve them before submitting.";
    case "checks_failing":
      return "Checks are failing — fix CI during this run.";
    case "needs_approval":
      return "Waiting on approvals, but code can merge cleanly.";
    case "unstable":
      return "Mergeable state is unstable — double-check CI and merge readiness.";
    case "clean":
      return "Branch is clean and mergeable. Still sync with the base branch before working.";
    default:
      return "Mergeability unknown. Fetch latest main and assume conflicts until proven otherwise.";
  }
}

export function buildReviewPrompt(task: Task, options?: ReviewPromptOptions): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const agentName = agentConfig?.name || task.agent;
  const template = loadTemplate("review.md");
  const mergeStatus = describeMergeStatus(options?.prStatus || task.pr_status);
  const baseBranch = options?.baseBranch || agentConfig?.default_branch || "main";
  const agentDirectory = buildAgentDirectory(config, task.agent);

  const prompt = template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{MERGE_STATUS}}", mergeStatus)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);

  return appendManualInstruction(prompt, task);
}

export function buildCleanupPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("cleanup.md");
  const repoContext = agentConfig
    ? loadAgentPrompt(agentConfig.prompt_file)
    : "No agent-specific cleanup instructions.";
  const agentDirectory = buildAgentDirectory(config, task.agent);

  return template
    .replace(/\{\{FINAL_STATUS\}\}/g, task.status)
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace("{{PR_URL}}", task.pr_url || "None")
    .replace("{{BRANCH_NAME}}", task.branch_name || "Unknown")
    .replace("{{REPO_CONTEXT}}", repoContext)
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

function buildAgentDirectory(
  config: OrchestratorConfig,
  currentAgentId: string
): string {
  const entries = Object.entries(config.agents);
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(([id, agent]) => formatAgentDescription(id, agent, id === currentAgentId))
    .join("\n");
}

function formatAgentDescription(
  id: string,
  agent: AgentConfig,
  isCurrent: boolean
): string {
  const name = agent.name || id;
  const description = agent.description?.trim() || "No description provided.";
  const repo = agent.repo_slug ? `Repo: ${agent.repo_slug}` : "";
  const currentTag = isCurrent ? " (current)" : "";
  const detail = [description, repo].filter(Boolean).join(" — ");
  return `- **${name}** (\`${id}\`)${currentTag}: ${detail}`;
}

function appendManualInstruction(prompt: string, task: Task): string {
  if (!task.pending_manual_instruction?.trim()) {
    return prompt;
  }
  return `${prompt}\n\n## Manual Instruction\n\n${task.pending_manual_instruction.trim()}`;
}
