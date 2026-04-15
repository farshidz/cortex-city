import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";
import { getTask } from "@/lib/store";
import type { Task } from "@/lib/types";

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

  const runtime = task.agent_runner || "claude";
  if (!task.session_id && runtime !== "codex")
    return NextResponse.json({ error: "No session data" }, { status: 404 });
  if (runtime === "codex") {
    const codexResult = loadCodexSession(task);
    if (codexResult) return NextResponse.json(codexResult);
  } else {
    const claudeResult = loadClaudeSession(task);
    if (claudeResult) return NextResponse.json(claudeResult);
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
    .sort();
  const messages: CodexSessionMessage[] = [];
  let sessionId: string | undefined;
  let matched = false;
  for (const file of logFiles) {
    const fullPath = path.join(LOGS_DIR, file);
    const content = readFileSync(fullPath, "utf-8");
    if (task.session_id && !content.includes(task.session_id)) continue;
    const startTimestamp = parseCodexStartTimestamp(content) || task.last_run_at;
    const parsed = parseCodexLog(content, startTimestamp);
    if (!parsed) continue;
    matched = true;
    if (!sessionId && parsed.sessionId) {
      sessionId = parsed.sessionId;
    }
    messages.push(...parsed.messages);
  }
  if (!matched) return null;

  const hasUser = messages.some((msg) => msg.role === "user");
  const mergedMessages = hasUser
    ? messages
    : [
        {
          role: "user" as const,
          content:
            task.description ||
            "Task description unavailable. See task page for details.",
          timestamp: task.created_at,
        },
        ...messages,
      ];

  return {
    session_id: sessionId || task.session_id,
    message_count: mergedMessages.length,
    messages: mergedMessages,
    agent_runner: "codex" as const,
  };
}

function parseCodexStartTimestamp(content: string): string | undefined {
  const firstLine = content.split("\n")[0];
  const match = firstLine.match(/Session started at (.+?) ---/);
  return match ? match[1] : undefined;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  timestamp?: string;
  mode?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
  };
  message?: string;
  content?: string;
}

type CodexSessionMessage = SessionMessage & { agent_label?: string };

function parseCodexLog(content: string, fallbackTimestamp?: string): {
  sessionId?: string;
  messages: CodexSessionMessage[];
} | null {
  const messages: CodexSessionMessage[] = [];
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
    if (entry.type === "prompt") {
      const modeLabel = entry.mode
        ? `${entry.mode.charAt(0).toUpperCase()}${entry.mode.slice(1)} prompt`
        : "Prompt";
      const text = `### ${modeLabel}\n\n${entry.content || ""}`;
      messages.push({
        role: "user",
        content: text,
        timestamp: entry.timestamp || fallbackTimestamp,
      });
      continue;
    }
    if (entry.type === "thread.started" && entry.thread_id) {
      sessionId = entry.thread_id;
    }
    if (entry.type === "item.completed" && entry.item?.type === "agent_message") {
      messages.push({
        role: "assistant",
        content: entry.item.text || "",
        timestamp: entry.timestamp || fallbackTimestamp,
        agent_label: "Codex",
      });
    }
    if (entry.type === "item.completed" && entry.item?.type === "command_execution") {
      const output = entry.item.aggregated_output?.trim();
      const text = `Ran command: ${entry.item.command}\n${output ? `Output:\n${output}` : ""}`.trim();
      messages.push({
        role: "assistant",
        content: text,
        timestamp: entry.timestamp || fallbackTimestamp,
        agent_label: "Codex",
      });
    }
    if (entry.type === "error" && entry.message) {
      messages.push({
        role: "assistant",
        content: `Error: ${entry.message}`,
        timestamp: entry.timestamp || fallbackTimestamp,
        agent_label: "Codex",
      });
    }
  }
  if (messages.length === 0) return null;
  return { sessionId, messages };
}
