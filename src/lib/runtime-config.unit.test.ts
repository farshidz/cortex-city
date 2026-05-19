// In-process tests that re-exercise every export from runtime-config so the
// duplicate-instrumentation entries c8 creates for re-export wrappers get
// counted alongside the direct function bodies.
import test from "node:test";
import assert from "node:assert/strict";

import * as rc from "./runtime-config";
import type { OrchestratorConfig } from "./types";

const config: OrchestratorConfig = {
  max_parallel_sessions: 2,
  poll_interval_seconds: 30,
  default_permission_mode: "bypassPermissions",
  default_agent_runner: "claude",
  default_claude_model: "claude-sonnet-4-6",
  default_claude_effort: "high",
  default_codex_model: "gpt-5.4",
  default_codex_effort: "medium",
  agents: {},
};

test("every runtime-config helper is reachable via the module namespace", () => {
  // Touch every export so re-export wrappers (c8 counts them as separate
  // functions) land in the covered set.
  assert.equal(typeof rc.formatEffortLabel, "function");
  assert.equal(typeof rc.getDefaultEffortForRuntime, "function");
  assert.equal(typeof rc.getDefaultModelForRuntime, "function");
  assert.equal(typeof rc.getEffortOptions, "function");
  assert.equal(typeof rc.getPermissionOptions, "function");
  assert.equal(typeof rc.normalizeEffort, "function");
  assert.equal(typeof rc.normalizeModel, "function");
  assert.equal(typeof rc.normalizePermissionMode, "function");
  assert.equal(typeof rc.resolveTaskEffort, "function");
  assert.equal(typeof rc.resolveTaskModel, "function");
  assert.equal(typeof rc.resolveTaskRuntime, "function");

  assert.equal(rc.formatEffortLabel("xhigh"), "Extra High");
  assert.equal(rc.formatEffortLabel(undefined), "CLI default");
  assert.equal(rc.formatEffortLabel("high"), "High");

  assert.equal(rc.getDefaultEffortForRuntime(config, "claude"), "high");
  assert.equal(rc.getDefaultEffortForRuntime(config, "codex"), "medium");
  assert.equal(rc.getDefaultModelForRuntime(config, "claude"), "claude-sonnet-4-6");
  assert.equal(rc.getDefaultModelForRuntime(config, "codex"), "gpt-5.4");

  assert.equal(rc.getEffortOptions("claude").length > 0, true);
  assert.equal(rc.getPermissionOptions("codex").length > 0, true);

  assert.equal(
    rc.normalizePermissionMode("claude", "bypassPermissions"),
    "bypassPermissions"
  );
  assert.equal(rc.normalizePermissionMode("codex", "invalid" as never), "default");

  assert.equal(rc.normalizeEffort("claude", "high"), "high");
  assert.equal(rc.normalizeEffort("codex", "max" as never), undefined);
  assert.equal(rc.normalizeEffort("codex", undefined, config), "medium");

  assert.equal(rc.normalizeModel("  trim-me "), "trim-me");
  assert.equal(rc.normalizeModel(undefined, "fallback"), "fallback");
  assert.equal(rc.normalizeModel(undefined), undefined);

  assert.equal(rc.resolveTaskRuntime({ agent_runner: "codex" }, config), "codex");
  assert.equal(rc.resolveTaskRuntime({}, config), "claude");
  assert.equal(
    rc.resolveTaskModel({ agent_runner: "claude", model: "custom" }, config),
    "custom"
  );
  assert.equal(rc.resolveTaskModel({}, config), "claude-sonnet-4-6");
  assert.equal(
    rc.resolveTaskEffort({ agent_runner: "codex", effort: "xhigh" }, config),
    "xhigh"
  );
  assert.equal(rc.resolveTaskEffort({}, config), "high");
});
