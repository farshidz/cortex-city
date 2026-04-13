"use client";

import useSWR from "swr";
import Link from "next/link";
import { Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import type { Task, TaskStatus } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins >= 60) return `${(mins / 60).toFixed(1)}h`;
  return `${mins}m`;
}

function getRowClass(task: Task): string {
  if (task.current_run_pid) return "animate-pulse-green";
  if (task.status === "merged" || task.status === "closed") {
    return "bg-muted/40 opacity-60";
  }
  if (task.pr_status === "clean") return "bg-green-500/10";
  if (task.pr_status === "checks_failing" || task.pr_status === "conflicts")
    return "bg-red-500/10";
  if (task.pr_status === "needs_approval") return "bg-yellow-500/10";
  if (task.pr_status === "checks_pending") return "animate-pulse-blue";
  return "";
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  in_review: "bg-purple-100 text-purple-800",
  merged: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-800",
};

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: tasks, mutate } = useSWR<Task[]>("/api/tasks", fetcher, {
    refreshInterval: 5000,
  });

  const sorted = tasks?.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  const filtered =
    statusFilter === "all"
      ? sorted
      : sorted?.filter((t) => t.status === statusFilter);

  async function updateStatus(id: string, status: TaskStatus) {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    mutate();
  }

  async function triggerAgent(id: string) {
    // Clear the GH state hash to force the worker to pick it up on next poll
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_review_gh_state: null }),
    });
    mutate();
  }

  async function deleteTask(task: Task) {
    const isFinal = task.status === "merged" || task.status === "closed";
    if (isFinal) {
      if (!confirm("Delete this task?")) return;
    } else {
      const input = prompt(
        `This task is "${task.status}". Type "confirm" to delete it.`
      );
      if (input !== "confirm") return;
    }
    await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    mutate();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <Link href="/tasks/new">
          <Button>New Task</Button>
        </Link>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={setStatusFilter}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="in_progress">In Progress</TabsTrigger>
          <TabsTrigger value="in_review">In Review</TabsTrigger>
          <TabsTrigger value="merged">Merged</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>
      </Tabs>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[80px]">ID</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered?.map((task) => (
            <TableRow key={task.id} className={getRowClass(task)}>
              <TableCell className="font-mono text-xs">
                {task.id.slice(0, 8)}
              </TableCell>
              <TableCell>
                <Link
                  href={`/tasks/${task.id}`}
                  className="hover:underline font-medium"
                >
                  {task.title}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{task.agent || "—"}</Badge>
              </TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[task.status]}`}
                >
                  {task.status.replace("_", " ")}
                </span>
              </TableCell>
              <TableCell className="text-sm">
                {(task.total_input_tokens || task.total_output_tokens)
                  ? `${formatTokens(
                      (task.total_input_tokens || 0) +
                        (task.total_output_tokens || 0)
                    )}${task.total_duration_ms ? ` / ${formatDuration(task.total_duration_ms)}` : ""}`
                  : "—"}
              </TableCell>
              <TableCell className="text-sm">{task.run_count || 0}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {task.last_run_at
                  ? new Date(task.last_run_at).toLocaleString()
                  : "—"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex gap-1 justify-end">
                  {task.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateStatus(task.id, "closed")}
                    >
                      Close
                    </Button>
                  )}
                  {task.status === "in_review" && task.pr_url && (
                    <a
                      href={task.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button size="sm" variant="outline">
                        PR
                      </Button>
                    </a>
                  )}
                  {task.status === "in_review" && !task.current_run_pid && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => triggerAgent(task.id)}
                      title="Trigger agent review"
                    >
                      <Play className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => deleteTask(task)}
                  >
                    Del
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {(!filtered || filtered.length === 0) && (
            <TableRow>
              <TableCell
                colSpan={8}
                className="text-center text-muted-foreground py-8"
              >
                No tasks found.{" "}
                <Link href="/tasks/new" className="underline">
                  Create one
                </Link>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500/20 border border-green-500/30 animate-pulse" />
          Agent running
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-blue-500/20 border border-blue-500/30 animate-pulse" />
          CI running
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500/20 border border-green-500/30" />
          Ready to merge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-yellow-500/20 border border-yellow-500/30" />
          Needs approval
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-red-500/20 border border-red-500/30" />
          Required checks failing / conflicts
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-muted border border-border" />
          Merged / closed
        </span>
      </div>
    </div>
  );
}
