// In-process unit tests for prompt-builder internal helpers exposed via
// __testUtils. The build* prompt functions themselves rely on PROMPTS_DIR
// captured at module load time, so those stay covered by the subprocess
// tests in prompt-builder.test.ts.
import test from "node:test";
import assert from "node:assert/strict";

import { __testUtils } from "./prompt-builder";
import type { AgentConfig, OrchestratorConfig, Task, TaskStackedPR } from "./types";

const {
  buildPromptContextSection,
  buildStackSection,
  describeMergeStatus,
  formatAgentDescription,
  buildAgentDirectory,
  loadPromptFile,
} = __testUtils;

test("buildPromptContextSection skips empty content and wraps non-empty content", () => {
  assert.equal(buildPromptContextSection("Title"), "");
  assert.equal(buildPromptContextSection("Title", ""), "");
  assert.equal(buildPromptContextSection("Title", "body"), "## Title\nbody\n");
});

test("describeMergeStatus covers every known PR state", () => {
  assert.match(describeMergeStatus("conflicts", "main"), /merge conflicts/);
  assert.match(describeMergeStatus("checks_failing", "main"), /Checks are failing/);
  assert.match(
    describeMergeStatus("needs_approval", "main"),
    /Waiting on approvals/
  );
  assert.match(
    describeMergeStatus("unstable", "main"),
    /Mergeable state is unstable/
  );
  assert.match(describeMergeStatus("clean", "main"), /clean and mergeable/);
  // Unknown / undefined falls back to the base-branch hint.
  assert.match(
    describeMergeStatus(undefined, "develop"),
    /Fetch latest develop and assume conflicts/
  );
  assert.match(
    describeMergeStatus("weird-state", "main"),
    /Mergeability unknown/
  );
});

test("formatAgentDescription assembles agent directory entries", () => {
  const agent: AgentConfig = {
    name: "Test Agent",
    repo_slug: "acme/widget",
    prompt_file: "prompts/agents/test.md",
    default_branch: "main",
    description: " owns the dashboard ",
    working_directory: "src",
  };
  assert.equal(
    formatAgentDescription("test", agent, false),
    "- **Test Agent** (`test`): owns the dashboard — Repo: acme/widget — Workdir: src"
  );
  const current = formatAgentDescription("test", agent, true);
  assert.match(current, /\(current\)/);
});

test("formatAgentDescription falls back when fields are missing", () => {
  const sparse: AgentConfig = {
    name: "",
    repo_slug: "",
    prompt_file: "p.md",
    default_branch: "main",
  };
  const rendered = formatAgentDescription("only-id", sparse, false);
  assert.match(rendered, /\*\*only-id\*\* \(`only-id`\)/);
  assert.match(rendered, /No description provided\./);
});

test("buildAgentDirectory returns empty when there are no agents", () => {
  const config: OrchestratorConfig = {
    max_parallel_sessions: 1,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {},
  };
  assert.equal(buildAgentDirectory(config, "missing"), "");
});

test("buildAgentDirectory joins each agent with a leading dash and current marker", () => {
  const config: OrchestratorConfig = {
    max_parallel_sessions: 1,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {
      alpha: {
        name: "Alpha",
        repo_slug: "acme/a",
        prompt_file: "p",
        default_branch: "main",
      },
      beta: {
        name: "Beta",
        repo_slug: "acme/b",
        prompt_file: "p",
        default_branch: "main",
      },
    },
  };
  const dir = buildAgentDirectory(config, "beta");
  assert.match(dir, /Alpha/);
  assert.match(dir, /Beta.+\(current\)/);
});

test("loadPromptFile returns undefined for missing or empty files", () => {
  // Definitely missing path on macOS.
  assert.equal(loadPromptFile("/does/not/exist/at-all-prompt.md"), undefined);
});

function stackedTask(stack: TaskStackedPR[]): Task {
  return {
    id: "task-1",
    title: "Stacked work",
    description: "",
    status: "in_review",
    agent: "cortex-city-swe",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    stacked_prs: stack,
  };
}

test("buildStackSection is empty for non-stacked tasks", () => {
  assert.equal(buildStackSection(stackedTask([]), "main"), "");
  assert.equal(
    buildStackSection({ ...stackedTask([]), stacked_prs: undefined }, "main"),
    ""
  );
});

test("buildStackSection lists entries bottom-first with stack rules", () => {
  const section = buildStackSection(
    stackedTask([
      {
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        state: "open",
        pr_status: "clean",
      },
      {
        position: 1,
        pr_url: "https://github.com/acme/widget/pull/1",
        branch_name: "b1",
        base_branch: "main",
        scope: "Slice one",
        state: "open",
      },
    ]),
    "main"
  );
  assert.match(section, /## PR Stack/);
  const firstIndex = section.indexOf("PR 1: https://github.com/acme/widget/pull/1");
  const secondIndex = section.indexOf("PR 2: https://github.com/acme/widget/pull/2");
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex);
  assert.match(section, /merge status: clean/);
  assert.match(section, /Scope: Slice two/);
  assert.match(section, /origin\/main/);
  assert.doesNotMatch(section, /Restack required/);
});

test("buildStackSection routes closed unmerged bases to a human decision, not a restack", () => {
  const section = buildStackSection(
    stackedTask([
      {
        position: 1,
        pr_url: "https://github.com/acme/widget/pull/1",
        branch_name: "b1",
        base_branch: "main",
        scope: "Slice one",
        state: "closed",
      },
      {
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        state: "open",
      },
    ]),
    "main"
  );
  assert.doesNotMatch(section, /### Restack required/);
  assert.match(section, /### Broken stack — human decision required/);
  assert.match(section, /CLOSED WITHOUT MERGING/);
  assert.match(section, /Do NOT rebase, retarget, or force-push/);
  assert.match(section, /Report status `blocked`/);
});

test("buildStackSection restacks the whole open suffix above a merged entry", () => {
  const section = buildStackSection(
    stackedTask([
      {
        position: 1,
        pr_url: "https://github.com/acme/widget/pull/1",
        branch_name: "b1",
        base_branch: "main",
        scope: "Slice one",
        state: "merged",
      },
      {
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        state: "open",
      },
      {
        position: 3,
        pr_url: "https://github.com/acme/widget/pull/3",
        branch_name: "b3",
        base_branch: "b2",
        scope: "Slice three",
        state: "open",
      },
    ]),
    "main"
  );
  assert.match(section, /### Restack required/);
  // PR 3 is included even though its own base (b2) is still open.
  assert.match(section, /PR 2 \(https:\/\/github\.com\/acme\/widget\/pull\/2\)/);
  assert.match(section, /PR 3 \(https:\/\/github\.com\/acme\/widget\/pull\/3\)/);
  assert.match(section, /record the current tip of every branch/);
  assert.match(section, /Never restack only the lowest one/);
});

test("buildStackSection flags restack when an open entry bases on a merged branch", () => {
  const section = buildStackSection(
    stackedTask([
      {
        position: 1,
        pr_url: "https://github.com/acme/widget/pull/1",
        branch_name: "b1",
        base_branch: "main",
        scope: "Slice one",
        state: "merged",
      },
      {
        position: 2,
        pr_url: "https://github.com/acme/widget/pull/2",
        branch_name: "b2",
        base_branch: "b1",
        scope: "Slice two",
        state: "open",
      },
    ]),
    "main"
  );
  assert.match(section, /### Restack required/);
  assert.match(section, /PR 2 \(https:\/\/github\.com\/acme\/widget\/pull\/2\)/);
  assert.match(section, /--force-with-lease/);
  assert.match(section, /rebase --onto/);
});
