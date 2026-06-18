import { readFileSync } from "fs";
import path from "path";
import type { Task, AgentConfig, OrchestratorConfig } from "./types";
import { readConfig, readTasks } from "./store";
import { resolvePromptPath } from "./agent-files";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const CORTEX_CITY_REVIEWER_SIGNATURE = "🤖[Cortex City Reviewer]";

interface ReviewPromptOptions {
  prStatus?: string;
  baseBranch?: string;
}

interface InitialPromptOptions {
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

// Agents run a task repeatedly, but each run's structured report is fire-and-
// forget: a `create_task` request never echoes back into the agent's context,
// so on a later run the agent doesn't recall it already asked for, say,
// "Fix failing CI" and requests it again — piling up identical subtasks.
// Surfacing the follow-up tasks that already exist for this task gives the
// agent the memory it lacks so it can avoid the duplicate request. Merged and
// closed children are omitted so a genuinely recurring follow-up can still be
// raised once the previous one is resolved.
function getActiveFollowupTasks(task: Task): Task[] {
  return readTasks().filter(
    (candidate) =>
      candidate.parent_task_id === task.id &&
      candidate.status !== "merged" &&
      candidate.status !== "closed"
  );
}

function formatFollowupTaskList(children: Task[]): string {
  return children
    .map(
      (child) =>
        `- "${child.title}" — status: ${child.status}, owner agent: \`${child.agent}\``
    )
    .join("\n");
}

// Rendered into the `{{EXISTING_SUBTASKS}}` slot of the review template, which
// is re-sent on every PR-state wake. Always returns text so the section reads
// sensibly even before anything has been created.
function buildExistingFollowupTasksSection(task: Task): string {
  const children = getActiveFollowupTasks(task);
  if (children.length === 0) {
    return "None yet — you have not created any follow-up tasks for this task.";
  }
  return [
    "You have already created the following follow-up tasks for this task. Do NOT request another follow-up that duplicates any of them — assume the earlier request succeeded:",
    formatFollowupTaskList(children),
  ].join("\n");
}

// Appended to the string-built prompts (`continue`, manual instruction) that
// wake a long-running session. Those never re-render a template, so without
// this the agent would never see its existing subtasks on a resume. Returns ""
// when there is nothing to warn about so the prompt stays minimal.
function buildFollowupReminder(task: Task): string {
  const children = getActiveFollowupTasks(task);
  if (children.length === 0) return "";
  return [
    "",
    "",
    "## Existing Follow-up Tasks",
    "You have already created the following follow-up tasks for this task. Before adding any `create_task` entry to your final report, do NOT request another that duplicates one of them — assume the earlier request succeeded:",
    formatFollowupTaskList(children),
  ].join("\n");
}

export function buildContinuePrompt(task: Task): string {
  return `continue${buildFollowupReminder(task)}`;
}

export function buildManualInstructionPrompt(task: Task): string {
  const instruction = task.pending_manual_instruction?.trim();
  if (!instruction) return "";
  return `${instruction}${buildFollowupReminder(task)}`;
}

function describeMergeStatus(status: string | undefined, baseBranch: string): string {
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
      return `Mergeability unknown. Fetch latest ${baseBranch} and assume conflicts until proven otherwise.`;
  }
}

export function buildInitialPrompt(task: Task, options?: InitialPromptOptions): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const template = loadTemplate("initial.md");
  const repoContext = agentConfig
    ? loadPromptFile(resolvePromptPath(agentConfig, task.agent, "initial"))
    : undefined;

  const agentName = agentConfig?.name || task.agent;
  const agentDirectory = buildAgentDirectory(config, task.agent);
  const baseBranch = options?.baseBranch || agentConfig?.default_branch || "main";

  return template
    .replace("{{TASK_TITLE}}", task.title)
    .replace("{{TASK_DESCRIPTION}}", task.description)
    .replace(
      "{{TASK_PLAN}}",
      task.plan || "No detailed plan provided. Determine the best approach."
    )
    .replace("{{AGENT_NAME}}", agentName)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection(
        "Repository Context",
        repoContext || "No agent-specific context configured."
      )
    )
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

export function buildReviewPrompt(task: Task, options?: ReviewPromptOptions): string {
  const config = readConfig();
  const agentConfig = config.agents[task.agent];
  const agentName = agentConfig?.name || task.agent;
  const template = loadTemplate("review.md");
  const baseBranch = options?.baseBranch || agentConfig?.default_branch || "main";
  const agentDirectory = buildAgentDirectory(config, task.agent);
  const reviewContext = agentConfig
    ? loadPromptFile(resolvePromptPath(agentConfig, task.agent, "review"))
    : undefined;

  return template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{MERGE_STATUS}}", describeMergeStatus(options?.prStatus || task.pr_status, baseBranch))
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection("Agent Review Context", reviewContext)
    )
    .replace("{{EXISTING_SUBTASKS}}", buildExistingFollowupTasksSection(task))
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

export function buildReviewerPrompt(task: Task): string {
  const config = readConfig();
  const customInstructions = config.reviewer_agent_prompt?.trim();
  const sections = [
    "You are the reviewer agent for this task.",
    "",
    `Task: ${task.title}`,
    `Description: ${task.description || "No description provided."}`,
    `Plan: ${task.plan || "No detailed plan provided."}`,
    `PR: ${task.pr_url || "Unknown"}`,
    "",
    "Review the PR implementation against the task description and plan. Use GitHub tooling to inspect the diff and relevant code. Do not edit files, commit, or push.",
  ];

  if (customInstructions) {
    sections.push("", "Additional reviewer instructions:", customInstructions);
  }

  sections.push(
    "",
    "GitHub reviewer protocol:",
    "- Only comment on GitHub when you found something actionable for the implementation owner to change or fix.",
    "- If there is nothing to change or fix, do not create GitHub comments and do not submit a PR review. Return the required JSON status only.",
    "- Do not approve or request changes. Never use `--approve`, `--request-changes`, `APPROVE`, or `REQUEST_CHANGES`, even when findings are blocking.",
    "- If there are blocking findings, describe them in the comment review body and set your final JSON `status` to `needs_review`.",
    `- Start every GitHub comment or PR review body you create with \`${CORTEX_CITY_REVIEWER_SIGNATURE}\`. This includes top-level PR comments, inline review comments, and PR-level review bodies.`
  );

  sections.push("", "Then respond with the required JSON status.");
  return sections.join("\n");
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
  const workdir = agent.working_directory?.trim();
  const workingDirectory =
    workdir && workdir !== "." ? `Workdir: ${workdir}` : "";
  const currentTag = isCurrent ? " (current)" : "";
  const detail = [description, repo, workingDirectory].filter(Boolean).join(" — ");
  return `- **${name}** (\`${id}\`)${currentTag}: ${detail}`;
}

export const __testUtils = {
  buildPromptContextSection,
  describeMergeStatus,
  formatAgentDescription,
  buildAgentDirectory,
  loadPromptFile,
};
