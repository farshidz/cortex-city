import { readFileSync } from "fs";
import path from "path";
import type { Task, AgentConfig, OrchestratorConfig } from "./types";
import { readConfig } from "./store";
import { resolvePromptPath } from "./agent-files";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

interface ReviewPromptOptions {
  prStatus?: string;
  baseBranch?: string;
}

function loadTemplate(name: string): string {
  return readFileSync(path.join(PROMPTS_DIR, "templates", name), "utf-8");
}

function loadPromptFile(absolutePath: string): string | undefined {
  try {
    const content = readFileSync(absolutePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function buildPromptContextSection(title: string, content?: string): string {
  if (!content) return "";
  return `## ${title}\n${content}\n`;
}

export function buildInitialPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("initial.md");
  const repoContext = agentConfig
    ? loadPromptFile(resolvePromptPath(agentConfig, task.agent, "initial"))
    : undefined;

  const agentName = agentConfig?.name || task.agent;
  const agentDirectory = buildAgentDirectory(config, task.agent);

  return template
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace(
      "{{TASK_PLAN}}",
      task.plan || "No detailed plan provided. Determine the best approach."
    )
    .replace("{{AGENT_NAME}}", agentName)
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection(
        "Repository Context",
        repoContext || "No agent-specific context configured."
      )
    )
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

export function buildContinuePrompt(): string {
  return "continue";
}

export function buildManualInstructionPrompt(task: Task): string {
  return task.pending_manual_instruction?.trim() || "";
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
  const reviewContext = agentConfig
    ? loadPromptFile(resolvePromptPath(agentConfig, task.agent, "review"))
    : undefined;

  return template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{MERGE_STATUS}}", mergeStatus)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection("Agent Review Context", reviewContext)
    )
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

export function buildCleanupPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("cleanup.md");
  const cleanupContext = agentConfig
    ? loadPromptFile(resolvePromptPath(agentConfig, task.agent, "cleanup"))
    : undefined;
  const agentDirectory = buildAgentDirectory(config, task.agent);

  return template
    .replace(/\{\{FINAL_STATUS\}\}/g, task.status)
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace("{{PR_URL}}", task.pr_url || "None")
    .replace("{{BRANCH_NAME}}", task.branch_name || "Unknown")
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection("Agent Cleanup Context", cleanupContext)
    )
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
