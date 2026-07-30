import { readFileSync } from "fs";
import path from "path";
import type { Task, AgentConfig, OrchestratorConfig, TaskStackedPR } from "./types";
import { readConfig, readTasks } from "./store";
import { resolvePromptPath } from "./agent-files";
import {
  isStackedTask,
  stackEntriesOnClosedBase,
  stackEntriesRequiringRestack,
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

  return template
    .replace("{{PR_URL}}", task.pr_url || "Unknown")
    .replace("{{AGENT_NAME}}", agentName)
    .replace("{{MERGE_STATUS}}", describeMergeStatus(options?.prStatus || task.pr_status, baseBranch))
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch)
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

  const lines = [
    "## PR Stack",
    "This task owns a stack of PRs. Current recorded state (bottom first):",
    "",
    ...stack.map((entry) => describeStackEntry(entry)),
    "",
    "### Stack rules",
    `- Instruction 1 above (merging \`origin/${baseBranch}\`) applies only to the bottom open PR of the stack. Never merge \`${baseBranch}\` directly into a higher stack branch.`,
    "- Inspect all three feedback surfaces on EVERY open stack PR, not just the bottom one. Address feedback on the branch of the PR where it was left: check out that branch, commit, and push it.",
    "- Do not merge a lower stack branch into a higher one just because the lower branch gained commits. GitHub diffs each PR against its merge base, so upper PRs tolerate that drift until restack time.",
    "- Never open an additional PR or close an existing stack PR unless feedback explicitly asks for it.",
    "- In your final JSON, report the full current stack under `stacked_prs` (every entry, including merged or closed ones) with each entry's current branch, base, and scope.",
  ];

  if (restackEntries.length > 0) {
    lines.push(
      "",
      "### Restack required",
      `A PR below these open PRs has MERGED, so every open PR from the first affected one upward must be restacked in one pass: ${restackEntries
        .map((entry) => `PR ${entry.position} (${entry.pr_url})`)
        .join(", ")}.`,
      "Rebasing a branch rewrites it, which breaks the merge base of every stack branch above it — so restack ALL of the PRs listed above, bottom-up, in this session. Never restack only the lowest one.",
      "1. `git fetch origin` and confirm which stack PRs GitHub reports as merged.",
      "2. Before rewriting anything, record the current tip of every branch you are about to rebase (for example `git rev-parse origin/<branch>` for each listed PR's branch and its old base). The entry above each rewritten branch must be rebased relative to that OLD tip, not the rewritten one.",
      `3. For the lowest listed PR: retarget its base to the merged PR's own base (\`gh pr edit <number> --base <new-base>\`) unless GitHub already retargeted it after the old base branch was deleted, then \`git rebase --onto origin/<new-base> <old-base-tip> <branch>\` so the already-merged commits drop out. Squash merges rewrite merged commits, so the merged content must come from the new base — never keep the old stack commits.`,
      "4. For each PR above it, in order: rebase its branch onto the freshly rewritten branch below, using the OLD tip you recorded in step 2 as the `--onto` upstream boundary: `git rebase --onto <rewritten-lower-branch> <old-lower-tip> <branch>`.",
      "5. Resolve any rebase conflicts in this session.",
      "6. Push each restacked branch with `git push --force-with-lease`. This restack is the ONLY situation where rebasing and force-pushing are allowed; the no-rebase rule stays in force everywhere else.",
      "7. The worker independently verifies on GitHub that each merged slice's merge commit is an ancestor of every open PR above it, and keeps the restack flagged until that verification passes — so the branches must actually be rewritten and pushed; retargeting the PR base alone does not complete a restack."
    );
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
