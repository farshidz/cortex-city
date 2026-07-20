import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildModelArgs,
  buildModelArgsWith,
  buildPermissionArgs,
  buildReviewPermissionArgs,
} from "./runtime-args";
import type { OrchestratorConfig } from "./types";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const RUNTIME_ARGS_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "src/lib/runtime-args.ts")
).href;

function sampleConfig(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium",
    agents: {},
    ...overrides,
  };
}

test("buildPermissionArgs maps Claude permission modes verbatim", () => {
  assert.deepEqual(buildPermissionArgs("claude", "bypassPermissions"), [
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.deepEqual(buildPermissionArgs("claude", "acceptEdits"), [
    "--permission-mode",
    "acceptEdits",
  ]);
  assert.deepEqual(buildPermissionArgs("claude", "default"), [
    "--permission-mode",
    "default",
  ]);
  assert.deepEqual(buildPermissionArgs("claude", "auto"), [
    "--permission-mode",
    "auto",
  ]);
});

test("buildPermissionArgs translates yolo to bypassPermissions for Claude", () => {
  assert.deepEqual(buildPermissionArgs("claude", "yolo"), [
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("buildPermissionArgs uses Codex bypass flag for yolo / bypassPermissions", () => {
  assert.deepEqual(buildPermissionArgs("codex", "yolo"), [
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.deepEqual(buildPermissionArgs("codex", "bypassPermissions"), [
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
});

test("buildPermissionArgs falls back to --full-auto for other Codex modes", () => {
  assert.deepEqual(buildPermissionArgs("codex", "acceptEdits"), ["--full-auto"]);
  assert.deepEqual(buildPermissionArgs("codex", "default"), ["--full-auto"]);
});

test("buildReviewPermissionArgs restores the Codex bypass mode", () => {
  assert.deepEqual(buildReviewPermissionArgs("codex"), [
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ]);
});

test("buildReviewPermissionArgs restores the Claude bypass mode", () => {
  assert.deepEqual(buildReviewPermissionArgs("claude"), [
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("buildModelArgs prefers explicit task values over config defaults", () => {
  const config = sampleConfig();
  const args = buildModelArgs(
    "claude",
    { model: "claude-opus-4-7", effort: "max" },
    config
  );
  assert.deepEqual(args, ["--model", "claude-opus-4-7", "--effort", "max"]);
});

test("buildModelArgs supports the Claude xhigh effort", () => {
  const config = sampleConfig();
  const args = buildModelArgs(
    "claude",
    { model: "claude-opus-4-8", effort: "xhigh" },
    config
  );
  assert.deepEqual(args, ["--model", "claude-opus-4-8", "--effort", "xhigh"]);
});

test("buildModelArgs falls back to runtime-specific config defaults", () => {
  const config = sampleConfig();
  const claudeArgs = buildModelArgs("claude", {}, config);
  assert.deepEqual(claudeArgs, [
    "--model",
    "claude-sonnet-4-6",
    "--effort",
    "high",
  ]);
  const codexArgs = buildModelArgs("codex", {}, config);
  assert.deepEqual(codexArgs, [
    "--model",
    "gpt-5.4",
    "-c",
    'model_reasoning_effort="medium"',
  ]);
});

test("buildModelArgs supports the Codex max effort", () => {
  const config = sampleConfig({ default_codex_effort: undefined });
  const args = buildModelArgs("codex", { effort: "max" }, config);
  assert.deepEqual(args, [
    "--model",
    "gpt-5.4",
    "-c",
    'model_reasoning_effort="max"',
  ]);
});

test("buildModelArgs ignores efforts that aren't valid for the runtime", () => {
  const config = sampleConfig({ default_codex_effort: undefined });
  const args = buildModelArgs("codex", { effort: "not-real" as never }, config);
  assert.deepEqual(args, ["--model", "gpt-5.4"]);
});

test("buildModelArgsWith emits only the args it is given", () => {
  assert.deepEqual(buildModelArgsWith("claude", undefined, undefined), []);
  assert.deepEqual(buildModelArgsWith("claude", "  ", undefined), []);
  assert.deepEqual(buildModelArgsWith("claude", "claude-opus-4-7", "max"), [
    "--model",
    "claude-opus-4-7",
    "--effort",
    "max",
  ]);
  assert.deepEqual(
    buildModelArgsWith("codex", "gpt-5.4", "xhigh"),
    ["--model", "gpt-5.4", "-c", 'model_reasoning_effort="xhigh"']
  );
  assert.deepEqual(
    buildModelArgsWith("codex", "gpt-5.6-sol", "ultra"),
    ["--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"']
  );
});

test("buildEnv layers global and agent .env files with agent overrides winning", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "runtime-args-env-"));
  writeFileSync(
    path.join(workspace, ".env"),
    'SHARED="from-global"\nGLOBAL_ONLY=g\n'
  );
  writeFileSync(
    path.join(workspace, "agent.env"),
    "SHARED='from-agent'\nAGENT_ONLY=a\n"
  );

  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      [
        `import { buildEnv } from ${JSON.stringify(RUNTIME_ARGS_MODULE_URL)};`,
        "const env = buildEnv('agent.env');",
        "console.log(JSON.stringify({",
        "  SHARED: env.SHARED,",
        "  GLOBAL_ONLY: env.GLOBAL_ONLY,",
        "  AGENT_ONLY: env.AGENT_ONLY,",
        "  PROCESS_ENV_PRESENT: typeof env.PATH === 'string',",
        "}));",
      ].join("\n"),
    ],
    { cwd: workspace, encoding: "utf-8" }
  );

  const parsed = JSON.parse(output.trim().split(/\r?\n/).pop()!);
  assert.equal(parsed.SHARED, "from-agent");
  assert.equal(parsed.GLOBAL_ONLY, "g");
  assert.equal(parsed.AGENT_ONLY, "a");
  assert.equal(parsed.PROCESS_ENV_PRESENT, true);
});
