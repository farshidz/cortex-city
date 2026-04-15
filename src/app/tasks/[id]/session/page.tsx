"use client";

import { use } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Task } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ToolCall {
  name: string;
  input: string;
  result?: string;
}

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  tool_calls?: ToolCall[];
  agent_label?: string;
}

interface SessionData {
  session_id: string;
  message_count: number;
  messages: SessionMessage[];
  error?: string;
  agent_runner?: "claude" | "codex";
}

export default function SessionViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: task } = useSWR<Task>(`/api/tasks/${id}`, fetcher, {
    refreshInterval: 3000,
  });
  const { data: session } = useSWR<SessionData>(
    `/api/tasks/${id}/session`,
    fetcher,
    {
      refreshInterval: task?.current_run_pid ? 3000 : 0,
    }
  );
  const agentLabel = session?.agent_runner === "codex" ? "Codex" : "Claude";

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Session Log</h1>
          {task && (
            <p className="text-sm text-muted-foreground mt-1">
              {task.title}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={() => router.push(`/tasks/${id}`)}>
          Back to Task
        </Button>
      </div>

      {session?.error && (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            {session.error}
          </CardContent>
        </Card>
      )}

      {session?.messages && session.messages.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            No session messages found.
          </CardContent>
        </Card>
      )}

      {session?.messages?.map((msg, i) => (
        <Card
          key={i}
          className={
            msg.role === "user"
              ? "border-blue-500/30 bg-blue-500/5"
              : "border-border"
          }
        >
          <CardHeader className="py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant={msg.role === "user" ? "default" : "secondary"}>
                  {msg.role === "user" ? "You" : msg.agent_label || agentLabel}
                </Badge>
                {msg.tool_calls && msg.tool_calls.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {msg.tool_calls.length} tool{" "}
                    {msg.tool_calls.length === 1 ? "call" : "calls"}
                  </span>
                )}
              </div>
              {msg.timestamp && (
                <span className="text-xs text-muted-foreground">
                  {new Date(msg.timestamp).toLocaleString()}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {msg.content && (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            )}
            {msg.tool_calls?.map((tool, j) => (
              <div key={j} className="mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="font-mono text-xs">
                    {tool.name}
                  </Badge>
                </div>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-[300px] whitespace-pre-wrap">
                  {tool.input}
                </pre>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
