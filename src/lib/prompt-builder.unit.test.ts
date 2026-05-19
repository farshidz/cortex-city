// In-process unit tests for prompt-builder internal helpers exposed via
// __testUtils. The build* prompt functions themselves rely on PROMPTS_DIR
// captured at module load time, so those stay covered by the subprocess
// tests in prompt-builder.test.ts.
import test from "node:test";
import assert from "node:assert/strict";

import { __testUtils } from "./prompt-builder";
import type { AgentConfig, OrchestratorConfig } from "./types";

const { buildPromptContextSection, describeMergeStatus, formatAgentDescription, buildAgentDirectory, loadPromptFile } =
  __testUtils;

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
