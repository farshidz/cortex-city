import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentConfig, OrchestratorConfig } from "./types";

// Shared temp-workspace fixtures for orchestration tests. The helpers only
// write synthetic prompts, config, and CLI shims under a temp directory.
export const REPO_ROOT = process.cwd();
export const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

export function moduleUrl(relativePath: string): string {
  return pathToFileURL(path.join(REPO_ROOT, relativePath)).href;
}

export function createTempWorkspace(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

export function writePromptTemplates(workspace: string): void {
  mkdirSync(path.join(workspace, "prompts", "templates"), { recursive: true });
  writeFileSync(
    path.join(workspace, "prompts", "templates", "initial.md"),
    "INITIAL {{TASK_TITLE}} | {{TASK_DESCRIPTION}} | {{TASK_PLAN}} | {{BASE_BRANCH}} | {{AGENT_NAME}}"
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "review.md"),
    "REVIEW {{PR_URL}} | {{BASE_BRANCH}} | {{MERGE_STATUS}} | {{AGENT_NAME}}"
  );
  writeFileSync(
    path.join(workspace, "prompts", "templates", "cleanup.md"),
    "CLEANUP {{FINAL_STATUS}} | {{TASK_TITLE}} | {{AGENT_DIRECTORY}}"
  );
}

export function writeAgentPrompts(workspace: string): void {
  mkdirSync(path.join(workspace, "prompts", "agents"), { recursive: true });
  writeFileSync(
    path.join(workspace, "prompts", "agents", "cortex-city-swe.md"),
    "Agent-specific prompt"
  );
  writeFileSync(
    path.join(workspace, "prompts", "agents", "docs-agent.md"),
    "Docs prompt"
  );
}

export function buildTestConfig(
  workspace: string,
  overrides: Partial<OrchestratorConfig> = {},
  agentOverrides: Partial<Record<string, Partial<AgentConfig>>> = {}
): OrchestratorConfig {
  const agents: Record<string, AgentConfig> = {
    "cortex-city-swe": {
      name: "Cortex City SWE",
      repo_slug: "example/cortex-city",
      repo_path: workspace,
      prompt_file: "prompts/agents/cortex-city-swe.md",
      default_branch: "main",
      description: "Owns the control panel and worker.",
      ...agentOverrides["cortex-city-swe"],
    },
    "docs-agent": {
      name: "Docs Agent",
      repo_slug: "example/docs-site",
      repo_path: workspace,
      prompt_file: "prompts/agents/docs-agent.md",
      default_branch: "docs-main",
      ...agentOverrides["docs-agent"],
    },
  };

  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    task_run_timeout_ms: 10 * 60 * 1000,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "codex",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "xhigh",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "max",
    agents,
    ...overrides,
  };
}

export function writeTestConfig(
  workspace: string,
  overrides: Partial<OrchestratorConfig> = {},
  agentOverrides: Partial<Record<string, Partial<AgentConfig>>> = {}
): OrchestratorConfig {
  const config = buildTestConfig(workspace, overrides, agentOverrides);
  // Store helpers resolve config from <cwd>/.cortex, so tests write synthetic
  // state into the temp workspace instead of reading repo-local files.
  writeJson(path.join(workspace, ".cortex", "config.json"), config);
  return config;
}

export function writeFakeAgentBinary(
  workspace: string,
  binaryName: "codex" | "claude"
): string {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, binaryName);
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("fs");

function readScenario() {
  const file = process.env.FAKE_AGENT_SCENARIO_FILE;
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed[${JSON.stringify(binaryName)}] || null;
  } catch {
    return null;
  }
}

const scenario = readScenario() || {};
const args = process.argv.slice(2);
const payload = {
  binary: ${JSON.stringify(binaryName)},
  args,
  cwd: process.cwd(),
  env: {
    GLOBAL_ONLY: process.env.GLOBAL_ONLY,
    AGENT_ONLY: process.env.AGENT_ONLY,
    SHARED: process.env.SHARED,
  },
};

if (process.env.FAKE_AGENT_ARGS_FILE) {
  writeFileSync(process.env.FAKE_AGENT_ARGS_FILE, JSON.stringify(payload));
}
if (process.env.FAKE_AGENT_CALLS_FILE) {
  appendFileSync(process.env.FAKE_AGENT_CALLS_FILE, JSON.stringify(payload) + "\\n");
}

const stdout = scenario.stdout ?? process.env.FAKE_AGENT_STDOUT ?? "";
const stderr = scenario.stderr ?? process.env.FAKE_AGENT_STDERR ?? "";
const exitCode = Number(scenario.exitCode ?? process.env.FAKE_AGENT_EXIT_CODE ?? 0);
const sleepMs = Number(scenario.sleepMs ?? process.env.FAKE_AGENT_SLEEP_MS ?? 0);

setTimeout(() => {
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  process.exit(exitCode);
}, sleepMs);
`
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

export function writeFakeGhBinary(workspace: string): string {
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, "gh");
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("fs");

function loadState() {
  const file = process.env.FAKE_GH_STATE_FILE;
  if (!file || !existsSync(file)) return { prs: {} };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { prs: {} };
  }
}

function logCall(args) {
  const file = process.env.FAKE_GH_CALLS_FILE;
  if (!file) return;
  appendFileSync(file, JSON.stringify(args) + "\\n");
}

function parsePrUrl(url) {
  const match = url && url.match(/github\\.com\\/([^/]+)\\/([^/]+)\\/pull\\/(\\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function getPr(state, owner, repo, number) {
  return state.prs?.[\`\${owner}/\${repo}#\${number}\`] || {};
}

function output(value) {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    process.stdout.write(value);
    return;
  }
  process.stdout.write(JSON.stringify(value));
}

const args = process.argv.slice(2);
const state = loadState();
logCall(args);

if (args[0] === "api") {
  if (args[1] === "--paginate" && args[2] === "--slurp") {
    const endpoint = args[3];
    const match = endpoint.match(/^repos\\/([^/]+)\\/([^/]+)\\/(pulls|issues)\\/(\\d+)\\/(reviews|comments)$/);
    if (!match) process.exit(0);
    const [, owner, repo, scope, number, resource] = match;
    const pr = getPr(state, owner, repo, number);
    if (scope === "pulls" && resource === "reviews") {
      output([pr.reviews || []]);
      process.exit(0);
    }
    if (scope === "pulls" && resource === "comments") {
      output([pr.comments || []]);
      process.exit(0);
    }
    if (scope === "issues" && resource === "comments") {
      output([pr.issueComments || []]);
      process.exit(0);
    }
    process.exit(0);
  }

  const endpoint = args[1];
  const jqIndex = args.indexOf("--jq");
  const jq = jqIndex >= 0 ? args[jqIndex + 1] : "";
  const match = endpoint.match(/^repos\\/([^/]+)\\/([^/]+)\\/pulls\\/(\\d+)$/);
  if (!match) process.exit(0);
  const [, owner, repo, number] = match;
  const pr = getPr(state, owner, repo, number);
  if (jq === '.state + "|" + (.merged | tostring)') {
    output(\`\${pr.state || "open"}|\${String(Boolean(pr.merged))}\`);
    process.exit(0);
  }
  if (jq === '{mergeable_state, mergeable}') {
    output({
      mergeable_state: pr.mergeable_state || "clean",
      mergeable: pr.mergeable ?? true,
    });
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "checks") {
  const prInfo = parsePrUrl(args[2]);
  if (!prInfo) process.exit(0);
  const pr = getPr(state, prInfo.owner, prInfo.repo, prInfo.number);
  const jqIndex = args.indexOf("--jq");
  const jq = jqIndex >= 0 ? args[jqIndex + 1] : "";
  const checks = pr.checks || [];
  if (jq === '[.[] | select(.state != "SUCCESS" and .state != "FAILURE" and .state != "CANCELLED" and .state != "SKIPPED" and .state != "STALE" and .state != "ERROR" and .state != "NEUTRAL" and .state != "STARTUP_FAILURE")] | length') {
    const pending = checks.filter((check) => !["SUCCESS", "FAILURE", "CANCELLED", "SKIPPED", "STALE", "ERROR", "NEUTRAL", "STARTUP_FAILURE"].includes(check.state)).length;
    output(String(pr.pending_count ?? pending));
    process.exit(0);
  }
  if (jq === '[.[] | .name + "=" + .state] | sort | join(",")') {
    output(checks.map((check) => \`\${check.name}=\${check.state}\`).sort().join(","));
    process.exit(0);
  }
  output(checks);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const prInfo = parsePrUrl(args[2]);
  if (!prInfo) process.exit(0);
  const pr = getPr(state, prInfo.owner, prInfo.repo, prInfo.number);
  output({
    headRefOid: pr.headRefOid || "",
    statusCheckRollup: pr.statusCheckRollup || pr.checks || [],
  });
}
`
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

export function prependBinToPath(workspace: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    ...env,
    PATH: `${path.join(workspace, "bin")}:${env.PATH || ""}`,
  };
}

export function runTsxScript(
  workspace: string,
  imports: string[],
  body: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        ...imports,
        "(async () => {",
        body,
        "})().catch((error) => {",
        "  console.error(error);",
        "  process.exit(1);",
        "});",
      ].join("\n"),
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
      env,
    }
  );

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function runGit(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function initGitTestRepo(
  workspace: string,
  defaultBranch = "main"
): { remotePath: string; repoPath: string } {
  const remotePath = path.join(workspace, "remote.git");
  const repoPath = path.join(workspace, "repo");

  runGit(workspace, ["init", "--bare", remotePath]);
  runGit(workspace, ["clone", remotePath, repoPath]);
  runGit(repoPath, ["checkout", "-b", defaultBranch]);
  runGit(repoPath, ["config", "user.name", "Cortex Tests"]);
  runGit(repoPath, ["config", "user.email", "cortex@example.com"]);
  writeFileSync(path.join(repoPath, "README.md"), "# test repo\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "Initial commit"]);
  runGit(repoPath, ["push", "-u", "origin", defaultBranch]);

  return { remotePath, repoPath };
}
