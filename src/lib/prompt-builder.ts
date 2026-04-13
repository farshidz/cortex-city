import { readFileSync } from "fs";
import path from "path";
import type { Task } from "./types";
import { readConfig } from "./store";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

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

  return template
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace(
      "{{TASK_PLAN}}",
      task.plan || "No detailed plan provided. Determine the best approach."
    )
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{REPO_CONTEXT}}", repoContext);
}

export function buildReviewPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const agentName = agentConfig?.name || task.agent;
  const template = loadTemplate("review.md");

  return template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{ORIGINAL_TASK}}", task.description);
}

export function buildCleanupPrompt(task: Task): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("cleanup.md");
  const repoContext = agentConfig
    ? loadAgentPrompt(agentConfig.prompt_file)
    : "No agent-specific cleanup instructions.";

  return template
    .replace(/\{\{FINAL_STATUS\}\}/g, task.status)
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace("{{PR_URL}}", task.pr_url || "None")
    .replace("{{BRANCH_NAME}}", task.branch_name || "Unknown")
    .replace("{{REPO_CONTEXT}}", repoContext);
}
