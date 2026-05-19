import { readFileSync } from "fs";
import path from "path";
import {
  getDefaultModelForRuntime,
  normalizeEffort,
  normalizeModel,
} from "./runtime-config";
import type {
  AgentRuntime,
  OrchestratorConfig,
  PermissionMode,
  Task,
  TaskEffort,
} from "./types";

const GLOBAL_ENV_FILE = path.join(/* turbopackIgnore: true */ process.cwd(), ".env");

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // File doesn't exist or can't be read — that's fine
  }
  return vars;
}

export function buildEnv(agentEnvFile?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  Object.assign(env, loadEnvFile(GLOBAL_ENV_FILE));
  if (agentEnvFile) {
    const envPath = path.isAbsolute(agentEnvFile)
      ? agentEnvFile
      : path.join(/* turbopackIgnore: true */ process.cwd(), agentEnvFile);
    Object.assign(env, loadEnvFile(envPath));
  }
  return env;
}

export function buildPermissionArgs(
  runtime: AgentRuntime,
  mode: PermissionMode
): string[] {
  if (runtime === "codex") {
    if (mode === "yolo" || mode === "bypassPermissions") {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    return ["--full-auto"];
  }
  if (mode === "yolo") {
    return ["--permission-mode", "bypassPermissions"];
  }
  return ["--permission-mode", mode];
}

export function buildModelArgs(
  runtime: AgentRuntime,
  task: Pick<Task, "model" | "effort">,
  config: OrchestratorConfig
): string[] {
  const args: string[] = [];
  const model = normalizeModel(task.model, getDefaultModelForRuntime(config, runtime));
  if (model) {
    args.push("--model", model);
  }

  const effort = normalizeEffort(runtime, task.effort, config);
  if (runtime === "codex" && effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (runtime === "claude" && effort) {
    args.push("--effort", effort);
  }

  return args;
}

export function buildModelArgsWith(
  runtime: AgentRuntime,
  model: string | undefined,
  effort: TaskEffort | undefined
): string[] {
  const args: string[] = [];
  const normalizedModel = normalizeModel(model);
  if (normalizedModel) {
    args.push("--model", normalizedModel);
  }
  if (runtime === "codex" && effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  if (runtime === "claude" && effort) {
    args.push("--effort", effort);
  }
  return args;
}

export const __testUtils = {
  loadEnvFile,
};
