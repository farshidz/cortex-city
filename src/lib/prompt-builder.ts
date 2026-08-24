import { readFileSync } from "fs";
import path from "path";
import type { Task, AgentConfig, OrchestratorConfig, TaskStackedPR } from "./types";
import { readConfig, readTasks } from "./store";
import { resolvePromptPath } from "./agent-files";
import {
  isStackedTask,
  openStackedPRs,
  stackEntriesOnClosedBase,
  stackEntriesRequiringRestack,
  stackRequiresRestack,
} from "./stacked-prs";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

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
  const restackRequired = isStackedTask(task) && stackRequiresRestack(task.stacked_prs);
  const baseSyncInstruction = restackRequired
    ? `Immediately run \`git fetch origin\`. Follow the Restack required protocol above; do not merge \`origin/${baseBranch}\` into the branch before rebasing.`
    : `Immediately run \`git fetch origin\` and merge \`origin/${baseBranch}\` into your working branch. Do not rebase. If GitHub reports conflicts, resolve them now before moving on.`;

  return template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{MERGE_STATUS}}", describeMergeStatus(options?.prStatus || task.pr_status, baseBranch))
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
    .replace("{{BASE_SYNC_INSTRUCTION}}", baseSyncInstruction)
    .replace("{{STACK_SECTION}}", buildStackSection(task, baseBranch))
    .replace(
      "{{REPO_CONTEXT_SECTION}}",
      buildPromptContextSection("Agent Review Context", reviewContext)
    )
    .replace("{{EXISTING_SUBTASKS}}", buildExistingFollowupTasksSection(task))
    .replace("{{AGENT_DIRECTORY}}", agentDirectory);
}

function describeStackEntry(entry: TaskStackedPR): string {
  const detail = [
    `branch \`${entry.branch_name}\``,
    `base \`${entry.base_branch}\``,
    `state: ${entry.state}`,
    entry.state === "open" && entry.pr_status
      ? `merge status: ${entry.pr_status}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const scope = entry.scope ? `\n  Scope: ${entry.scope}` : "";
  return `- PR ${entry.position}: ${entry.pr_url} — ${detail}${scope}`;
}

// Stacked tasks get the whole-stack picture plus the rules that override the
// single-PR instructions (which branch to sync, when rebasing is allowed).
function buildStackSection(task: Task, baseBranch: string): string {
  if (!isStackedTask(task)) return "";
  const stack = [...task.stacked_prs].sort((a, b) => a.position - b.position);
  const restackEntries = stackEntriesRequiringRestack(stack);
  const openEntries = openStackedPRs(stack);
  const mergeTrainStarted = stack.some((entry) => entry.state === "merged");
  const frontier = openEntries[0];
  const heldEntries = mergeTrainStarted ? openEntries.slice(1) : [];

  const lines = [
    "## PR Stack",
    "This task owns a stack of PRs. Current recorded state (bottom first):",
    "",
    ...stack.map((entry) => describeStackEntry(entry)),
    "",
    "### Stack rules",
    mergeTrainStarted
      ? `- The serial merge train has started. ${frontier ? `PR ${frontier.position} (${frontier.pr_url}) is the frontier.` : "No open frontier remains."}`
      : "- The stack is in its initial review phase. Inspect all three feedback surfaces on EVERY open stack PR and address feedback on the branch where it was left.",
    ...(mergeTrainStarted
      ? [
          `- Inspect and address feedback only on the frontier after its restack is verified. Reviews are on hold for higher open PRs${heldEntries.length > 0 ? `: ${heldEntries.map((entry) => `PR ${entry.position}`).join(", ")}` : "."}`,
        ]
      : []),
    `- The generic base sync instruction applies only when no restack is pending. Never merge \`${baseBranch}\` directly into a higher stack branch.`,
    "- Do not merge a lower stack branch into a higher one just because the lower branch gained commits. GitHub diffs each PR against its merge base, so upper PRs tolerate that drift until restack time.",
    "- Never open an additional PR or close an existing stack PR unless feedback explicitly asks for it.",
    "- In your final JSON, report the full current stack under `stacked_prs` (every entry, including merged or closed ones) with each entry's current branch, base, and scope.",
  ];

  if (restackEntries.length > 0) {
    const entry = restackEntries[0];
    const cutoff = entry.restack_cutoff_sha?.trim();
    const lowerEntry = [...stack]
      .filter((candidate) => candidate.position < entry.position)
      .sort((a, b) => b.position - a.position)[0];
    const newBase = lowerEntry?.base_branch || baseBranch;
    lines.push(
      "",
      "### Restack required",
      `A lower PR has merged. Restack only the frontier, PR ${entry.position} (${entry.pr_url}), in this session. Do not rewrite any higher branch; its review remains on hold until it becomes the frontier.`
    );
    if (!cutoff) {
      lines.push(
        "No durable restack cutoff was captured. Do not rebase, retarget, or force-push the branch. Report `blocked`; the worker will retry cutoff capture before launching another restack run."
      );
    } else {
      lines.push(
        "This restack section overrides feedback Instructions 2–7 below. Perform the restack and report it; the worker will verify the rewrite and resume review afterward.",
        "1. `git fetch origin` and confirm which stack PRs GitHub reports as merged.",
        `2. Use the stored restack cutoff \`${cutoff}\`. It is the fork point that separates this PR's commits from the lower slice.`,
        `3. Retarget PR ${entry.position} to \`${newBase}\` (\`gh pr edit <number> --base ${newBase}\`) unless GitHub already did so, then run \`git rebase --onto origin/${newBase} ${cutoff} ${entry.branch_name}\`.`,
        "4. Resolve any conflicts in this session while preserving only this PR's intended slice.",
        `5. Push \`${entry.branch_name}\` with \`git push --force-with-lease\`. This is the only branch that may be force-pushed in this run.`,
        "6. The worker independently verifies that the lower merge commit is an ancestor of the frontier head. Retargeting alone does not complete the restack."
      );
    }
  }

  const closedBaseEntries = stackEntriesOnClosedBase(stack);
  if (closedBaseEntries.length > 0) {
    lines.push(
      "",
      "### Broken stack — human decision required",
      `These open PRs target the branch of a PR that was CLOSED WITHOUT MERGING: ${closedBaseEntries
        .map((entry) => `PR ${entry.position} (${entry.pr_url})`)
        .join(", ")}.`,
      "The closed PR's commits are NOT in any base branch, so the restack protocol above does not apply — rebasing its commits away would silently delete that slice's work. Do NOT rebase, retarget, or force-push these PRs, and do not reopen or close anything on your own.",
      "Report status `blocked` with a blocker explaining which PR was closed without merging and what decision is needed (reopen the closed PR, fold its changes into another slice, or abandon the stack)."
    );
  }

  lines.push("");
  return lines.join("\n");
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
  buildStackSection,
  describeMergeStatus,
  formatAgentDescription,
  buildAgentDirectory,
  loadPromptFile,
};
