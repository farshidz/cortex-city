import path from "path";
import type { AgentConfig } from "./types";

export function resolvePromptPath(agent: AgentConfig | undefined, agentId: string): string {
  const promptFile = agent?.prompt_file || `.cortex/prompts/agents/${agentId}.md`;
  return path.isAbsolute(promptFile)
    ? promptFile
    : path.join(process.cwd(), promptFile);
}

export function resolveEnvPath(agent: AgentConfig | undefined, agentId: string): string {
  const promptPath = resolvePromptPath(agent, agentId);
  const dir = path.dirname(promptPath);
  return path.join(dir, `.env.${agentId}`);
}

export function relativeFromCwd(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath);
  return relative || absolutePath;
}
