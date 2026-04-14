import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";
import { getTask } from "@/lib/store";

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "projects"
);
const LOGS_DIR = path.join(process.cwd(), "logs");

// Claude encodes the project path by replacing / with -
function worktreeToProjectId(worktreePath: string): string {
  return worktreePath.replace(/^\//, "").replace(/\//g, "-");
}

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  tool_calls?: { name: string; input: string; result?: string }[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task)
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!task.session_id)
    return NextResponse.json({ error: "No session data" }, { status: 404 });

  // Attempt to read Claude session files first
  const claudeResult = loadClaudeSession(task);
  if (claudeResult) return NextResponse.json(claudeResult);

  if (task.agent_runner === "codex") {
    const codexResult = loadCodexSession(task);
    if (codexResult) return NextResponse.json(codexResult);
  }

  return NextResponse.json({ error: "No session files found" }, { status: 404 });
}

function loadClaudeSession(task: Task) {
  let jsonlFiles: string[] = [];
  let projectDir = "";

  // Find the session JSONL file
  // Strategy 1: derive from worktree_path
  // Strategy 2: search all project dirs for the session ID
  if (task.worktree_path) {
    const projectId = worktreeToProjectId(task.worktree_path);
    projectDir = path.join(CLAUDE_PROJECTS_DIR, projectId);
    if (existsSync(projectDir)) {
      jsonlFiles = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    }
  }

  // Fallback: search for session ID across all project dirs
  if (jsonlFiles.length === 0 && existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const fullDir = path.join(CLAUDE_PROJECTS_DIR, dir);
      const sessionFile = `${task.session_id}.jsonl`;
      if (existsSync(path.join(fullDir, sessionFile))) {
        projectDir = fullDir;
        jsonlFiles = [sessionFile];
        break;
      }
    }
  }
  if (jsonlFiles.length === 0) {
    return null;
  }

  // Parse all sessions, most recent first
  const messages: SessionMessage[] = [];

  for (const file of jsonlFiles) {
    const content = readFileSync(path.join(projectDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        if (entry.type === "user" && entry.message) {
          const contentBlocks = entry.message.content;
          let text = "";
          if (typeof contentBlocks === "string") {
            text = contentBlocks;
          } else if (Array.isArray(contentBlocks)) {
            text = contentBlocks
              .filter(
                (b: { type: string }) =>
                  b.type === "text" || b.type === "tool_result"
              )
              .map((b: { type: string; text?: string; content?: string }) =>
                b.text || b.content || ""
              )
              .join("\n");
          }
          if (text.trim()) {
            messages.push({
              role: "user",
              content: text,
              timestamp: entry.timestamp,
            });
          }
        }

        if (entry.type === "assistant" && entry.message) {
          const contentBlocks = entry.message.content;
          let text = "";
          const toolCalls: SessionMessage["tool_calls"] = [];

          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              if (block.type === "text") {
                text += block.text;
              } else if (block.type === "tool_use") {
                toolCalls.push({
                  name: block.name,
                  input:
                    typeof block.input === "string"
                      ? block.input
                      : JSON.stringify(block.input, null, 2),
                });
              }
            }
          }

          if (text.trim() || toolCalls.length > 0) {
            messages.push({
              role: "assistant",
              content: text,
              timestamp: entry.timestamp,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return {
    session_id: task.session_id,
    message_count: messages.length,
    messages,
  };
}

function loadCodexSession(task: Task) {
  if (!existsSync(LOGS_DIR)) return null;
  const logFiles = readdirSync(LOGS_DIR)
    .filter((file) => file.startsWith(`task-${task.id}-`) && file.endsWith(".log"))
    .sort()
    .reverse();
  for (const file of logFiles) {
    const fullPath = path.join(LOGS_DIR, file);
    const content = readFileSync(fullPath, "utf-8");
    if (task.session_id && !content.includes(task.session_id)) continue;
    const parsed = parseCodexLog(content);
    if (parsed) {
      return {
        session_id: parsed.sessionId || task.session_id,
        message_count: parsed.messages.length,
        messages: parsed.messages,
      };
    }
  }
  return null;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  timestamp?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
  };
  message?: string;
}

function parseCodexLog(content: string): {
  sessionId?: string;
  messages: SessionMessage[];
} | null {
  const messages: SessionMessage[] = [];
  let sessionId: string | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let entry: CodexEvent;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "thread.started" && entry.thread_id) {
      sessionId = entry.thread_id;
    }
    if (entry.type === "item.completed" && entry.item?.type === "agent_message") {
      messages.push({
        role: "assistant",
        content: entry.item.text || "",
        timestamp: entry.timestamp,
      });
    }
    if (entry.type === "item.completed" && entry.item?.type === "command_execution") {
      const output = entry.item.aggregated_output?.trim();
      const text = `Ran command: ${entry.item.command}\n${output ? `Output:\n${output}` : ""}`.trim();
      messages.push({
        role: "assistant",
        content: text,
        timestamp: entry.timestamp,
      });
    }
    if (entry.type === "error" && entry.message) {
      messages.push({
        role: "assistant",
        content: `Error: ${entry.message}`,
        timestamp: entry.timestamp,
      });
    }
  }
  if (messages.length === 0) return null;
  return { sessionId, messages };
}
