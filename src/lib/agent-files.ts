import path from "path";
import type { AgentConfig, PromptMode } from "./types";

function defaultPromptFile(agentId: string, mode: PromptMode): string {
  if (mode === "initial") {
    return `.cortex/prompts/agents/${agentId}.md`;
  }
  return `.cortex/prompts/agents/${agentId}.${mode}.md`;
}

function getPromptFile(
  agent: AgentConfig | undefined,
  agentId: string,
  mode: PromptMode
): string {
  if (mode === "review") {
    return agent?.review_prompt_file || defaultPromptFile(agentId, mode);
  }
  if (mode === "cleanup") {
    return agent?.cleanup_prompt_file || defaultPromptFile(agentId, mode);
  }
  return agent?.prompt_file || defaultPromptFile(agentId, mode);
}

export function resolvePromptPath(
  agent: AgentConfig | undefined,
  agentId: string,
  mode: PromptMode = "initial"
): string {
  const promptFile = getPromptFile(agent, agentId, mode);
  return path.isAbsolute(promptFile)
    ? promptFile
    : path.join(/* turbopackIgnore: true */ process.cwd(), promptFile);
}

export function resolveEnvPath(agent: AgentConfig | undefined, agentId: string): string {
  const promptPath = resolvePromptPath(agent, agentId);
  const dir = path.dirname(promptPath);
  return path.join(dir, `.env.${agentId}`);
}

export function relativeFromCwd(absolutePath: string): string {
  const relative = path.relative(/* turbopackIgnore: true */ process.cwd(), absolutePath);
  return relative || absolutePath;
}
