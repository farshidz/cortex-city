import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { relativeFromCwd, resolveEnvPath, resolvePromptPath } from "./agent-files";
import type { AgentConfig } from "./types";

test("resolvePromptPath uses the configured relative prompt file", () => {
  const agent: AgentConfig = {
    name: "Cortex City SWE",
    repo_slug: "farshidz/marqo-cortex-city",
    repo_path: process.cwd(),
    prompt_file: "prompts/agents/cortex-city-swe.md",
    default_branch: "main",
  };

  assert.equal(
    resolvePromptPath(agent, "cortex-city-swe"),
    path.join(process.cwd(), "prompts/agents/cortex-city-swe.md")
  );
});

test("resolvePromptPath falls back to the default agent prompt location", () => {
  assert.equal(
    resolvePromptPath(undefined, "docs-agent"),
    path.join(process.cwd(), ".cortex/prompts/agents/docs-agent.md")
  );
});

test("resolvePromptPath uses mode-specific defaults for review and cleanup prompts", () => {
  assert.equal(
    resolvePromptPath(undefined, "docs-agent", "review"),
    path.join(process.cwd(), ".cortex/prompts/agents/docs-agent.review.md")
  );
  assert.equal(
    resolvePromptPath(undefined, "docs-agent", "cleanup"),
    path.join(process.cwd(), ".cortex/prompts/agents/docs-agent.cleanup.md")
  );
});

test("resolvePromptPath preserves absolute prompt paths", () => {
  const absolutePrompt = path.join(os.tmpdir(), "absolute-agent-prompt.md");
  const agent: AgentConfig = {
    name: "Absolute Prompt Agent",
    repo_slug: "example/repo",
    repo_path: process.cwd(),
    prompt_file: absolutePrompt,
    default_branch: "main",
  };

  assert.equal(resolvePromptPath(agent, "absolute-agent"), absolutePrompt);
});

test("resolveEnvPath places the env file next to the resolved prompt", () => {
  const agent: AgentConfig = {
    name: "Cortex City SWE",
    repo_slug: "farshidz/marqo-cortex-city",
    repo_path: process.cwd(),
    prompt_file: "prompts/agents/cortex-city-swe.md",
    default_branch: "main",
  };

  assert.equal(
    resolveEnvPath(agent, "cortex-city-swe"),
    path.join(process.cwd(), "prompts/agents/.env.cortex-city-swe")
  );
});

test("resolvePromptPath honors configured review and cleanup prompt files", () => {
  const agent: AgentConfig = {
    name: "Cortex City SWE",
    repo_slug: "farshidz/marqo-cortex-city",
    repo_path: process.cwd(),
    prompt_file: "prompts/agents/cortex-city-swe.md",
    review_prompt_file: "prompts/agents/cortex-city-swe.review.md",
    cleanup_prompt_file: "prompts/agents/cortex-city-swe.cleanup.md",
    default_branch: "main",
  };

  assert.equal(
    resolvePromptPath(agent, "cortex-city-swe", "review"),
    path.join(process.cwd(), "prompts/agents/cortex-city-swe.review.md")
  );
  assert.equal(
    resolvePromptPath(agent, "cortex-city-swe", "cleanup"),
    path.join(process.cwd(), "prompts/agents/cortex-city-swe.cleanup.md")
  );
});

test("relativeFromCwd returns a stable relative path when possible", () => {
  const absolutePath = path.join(process.cwd(), "src/lib/store.ts");
  assert.equal(relativeFromCwd(absolutePath), path.join("src", "lib", "store.ts"));
});

test("relativeFromCwd returns the original path when it matches cwd exactly", () => {
  assert.equal(relativeFromCwd(process.cwd()), process.cwd());
});
