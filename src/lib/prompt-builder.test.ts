import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Task } from "./types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PROMPT_BUILDER_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/prompt-builder.ts")
).href;

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "prompt-builder-test-"));
}

function runPromptScript(workspace: string, body: string) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import * as prompts from ${JSON.stringify(PROMPT_BUILDER_MODULE_URL)};`,
        "(async () => {",
        body,
        "})().catch((error) => {",
        '  console.error(error);',
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
    }
  );

  return JSON.parse(output);
}

function writeTestTemplates(workspace: string) {
  mkdirSync(path.join(workspace, "prompts", "templates"), { recursive: true });
  writeFileSync(
    path.join(workspace, "prompts", "templates", "initial.md"),
    [
      "Title={{TASK_TITLE}}",
      "Description={{TASK_DESCRIPTION}}",
      "Plan={{TASK_PLAN}}",
      "Base={{BASE_BRANCH}}",
      "Again={{BASE_BRANCH}}",
      "Agent={{AGENT_NAME}}",
      "Git={{GIT_IDENTITY_SECTION}}",
      "{{REPO_CONTEXT_SECTION}}",
      "Directory={{AGENT_DIRECTORY}}",
    ].join("\n")
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "review.md"),
    [
      "PR={{PR_URL}}",
      "Agent={{AGENT_NAME}}",
      "Status={{MERGE_STATUS}}",
      "Git={{GIT_IDENTITY_SECTION}}",
      "Base={{BASE_BRANCH}}",
      "Again={{BASE_BRANCH}}",
      "{{REPO_CONTEXT_SECTION}}",
      "Directory={{AGENT_DIRECTORY}}",
    ].join("\n")
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "cleanup.md"),
    [
      "Final={{FINAL_STATUS}}",
      "Title={{TASK_TITLE}}",
      "Description={{TASK_DESCRIPTION}}",
      "PR={{PR_URL}}",
      "Branch={{BRANCH_NAME}}",
      "{{REPO_CONTEXT_SECTION}}",
      "Directory={{AGENT_DIRECTORY}}",
    ].join("\n")
  );
}

function writeConfig(workspace: string) {
  mkdirSync(path.join(workspace, ".cortex"), { recursive: true });
  mkdirSync(path.join(workspace, "prompts", "agents"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".cortex", "config.json"),
    JSON.stringify(
      {
        max_parallel_sessions: 2,
        poll_interval_seconds: 30,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "claude",
        agents: {
          "cortex-city-swe": {
            name: "Cortex City SWE",
            repo_slug: "farshidz/marqo-cortex-city",
            repo_path: workspace,
            prompt_file: "prompts/agents/cortex-city-swe.md",
            review_prompt_file: "prompts/agents/cortex-city-swe.review.md",
            cleanup_prompt_file: "prompts/agents/cortex-city-swe.cleanup.md",
            default_branch: "main",
            git_user_name: "Cortex Committer",
            git_user_email: "cortex@example.com",
            description: "Owns the Cortex City control panel.",
          },
          "marqo-documentation-agent": {
            name: "Marqo Documentation Agent",
            repo_slug: "marqo-ai/marqodocs",
            repo_path: workspace,
            prompt_file: "prompts/agents/marqo-documentation-agent.md",
            default_branch: "trunk",
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.md"),
    "Repository Context"
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.review.md"),
    "Review Context"
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.cleanup.md"),
    "Cleanup Context"
  );
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add unit tests",
    description: "Add comprehensive coverage",
    plan: "Cover the lib modules",
    status: "open",
    agent: "cortex-city-swe",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

test("buildInitialPrompt fills the template with task, agent, and directory details", () => {
  const workspace = createTempWorkspace();
  writeTestTemplates(workspace);
  writeConfig(workspace);

  const result = runPromptScript(
    workspace,
    `
      const task = ${JSON.stringify(sampleTask())};
      console.log(JSON.stringify(prompts.buildInitialPrompt(task)));
    `
  );

  assert.match(result, /Title=Add unit tests/);
  assert.match(result, /Description=Add comprehensive coverage/);
  assert.match(result, /Plan=Cover the lib modules/);
  assert.match(result, /Base=main/);
  assert.match(result, /Again=main/);
  assert.match(result, /Agent=Cortex City SWE/);
  assert.match(result, /Git=Before creating commits, configure the worktree/);
  assert.match(result, /git config user\.name 'Cortex Committer'/);
  assert.match(result, /git config user\.email 'cortex@example\.com'/);
  assert.match(result, /Commit as this name and email for this task/);
  assert.match(result, /## Repository Context\nRepository Context/);
  assert.match(
    result,
    /\*\*Cortex City SWE\*\* \(`cortex-city-swe`\) \(current\): Owns the Cortex City control panel\. — Repo: farshidz\/marqo-cortex-city/
  );
  assert.match(
    result,
    /\*\*Marqo Documentation Agent\*\* \(`marqo-documentation-agent`\): No description provided\. — Repo: marqo-ai\/marqodocs/
  );
});

test("buildInitialPrompt falls back when the task plan or agent prompt file is missing", () => {
  const workspace = createTempWorkspace();
  writeTestTemplates(workspace);
  writeConfig(workspace);

  const result = runPromptScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          agent: "marqo-documentation-agent",
          plan: undefined,
        })
      )};
      console.log(JSON.stringify(prompts.buildInitialPrompt(task)));
    `
  );

  assert.match(result, /Plan=No detailed plan provided\. Determine the best approach\./);
  assert.match(result, /Base=trunk/);
  assert.match(
    result,
    /Git=No agent-specific Git author identity is configured\.\nLeave the repository or machine Git config unchanged when committing\./
  );
  assert.match(result, /## Repository Context\nNo agent-specific context configured\./);
});

test("buildReviewPrompt maps PR states and replaces every base-branch placeholder", () => {
  const workspace = createTempWorkspace();
  writeTestTemplates(workspace);
  writeConfig(workspace);

  const result = runPromptScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          pr_url: "https://github.com/farshidz/marqo-cortex-city/pull/123",
          pr_status: "conflicts",
        })
      )};
      console.log(
        JSON.stringify(
          prompts.buildReviewPrompt(task, {
            prStatus: "checks_failing",
            baseBranch: "develop",
          })
        )
      );
    `
  );

  assert.match(result, /PR=https:\/\/github.com\/farshidz\/marqo-cortex-city\/pull\/123/);
  assert.match(result, /Status=Checks are failing — fix CI during this run\./);
  assert.match(result, /Git=Before creating commits, configure the worktree/);
  assert.match(result, /Base=develop/);
  assert.match(result, /Again=develop/);
  assert.match(result, /## Agent Review Context\nReview Context/);
});

test("buildReviewPrompt uses sensible defaults for unknown mergeability", () => {
  const workspace = createTempWorkspace();
  writeTestTemplates(workspace);
  writeConfig(workspace);

  const result = runPromptScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          agent: "marqo-documentation-agent",
          pr_url: undefined,
          pr_status: undefined,
        })
      )};
      console.log(JSON.stringify(prompts.buildReviewPrompt(task)));
    `
  );

  assert.match(result, /PR=Unknown/);
  assert.match(
    result,
    /Status=Mergeability unknown\. Fetch latest trunk and assume conflicts until proven otherwise\./
  );
  assert.match(result, /Base=trunk/);
  assert.doesNotMatch(result, /Agent Review Context/);
});

test("shared review template requires the robot prefix in GitHub replies", () => {
  const reviewTemplate = readFileSync(
    path.join(REPO_ROOT, "prompts", "templates", "review.md"),
    "utf-8"
  );

  assert.match(reviewTemplate, /Prefix your response with `\*\*🤖\[\{\{AGENT_NAME\}\}\]\*\* `/);
});

test("shared cleanup template leaves local worktree cleanup to the orchestrator", () => {
  const cleanupTemplate = readFileSync(
    path.join(REPO_ROOT, "prompts", "templates", "cleanup.md"),
    "utf-8"
  );

  assert.match(cleanupTemplate, /Do not remove the local worktree/);
  assert.match(cleanupTemplate, /Do not delete the local branch/);
  assert.match(cleanupTemplate, /The orchestrator removes the task worktree after this cleanup run exits/);
  assert.doesNotMatch(cleanupTemplate, /Delete the local and remote branch/);
});

test("buildCleanupPrompt and manual helpers provide the expected fallbacks", () => {
  const workspace = createTempWorkspace();
  writeTestTemplates(workspace);
  writeConfig(workspace);

  const result = runPromptScript(
    workspace,
    `
      const task = ${JSON.stringify(
        sampleTask({
          status: "closed",
          branch_name: undefined,
          pr_url: undefined,
          pending_manual_instruction: "  investigate flaky CI  ",
        })
      )};
      console.log(
        JSON.stringify({
          cleanup: prompts.buildCleanupPrompt(task),
          manual: prompts.buildManualInstructionPrompt(task),
          resume: prompts.buildContinuePrompt(),
          emptyManual: prompts.buildManualInstructionPrompt({
            ...task,
            pending_manual_instruction: "   ",
          }),
        })
      );
    `
  );

  assert.match(result.cleanup, /Final=closed/);
  assert.match(result.cleanup, /PR=None/);
  assert.match(result.cleanup, /Branch=Unknown/);
  assert.match(result.cleanup, /## Agent Cleanup Context\nCleanup Context/);
  assert.equal(result.manual, "investigate flaky CI");
  assert.equal(result.resume, "continue");
  assert.equal(result.emptyManual, "");
});
