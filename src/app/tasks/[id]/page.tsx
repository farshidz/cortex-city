"use client";

import { use, useState } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MdEditor } from "@/components/md-editor";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { Task, TaskStatus, OrchestratorConfig, AgentConfig } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const ALL_STATUSES: TaskStatus[] = [
  "open",
  "in_progress",
  "in_review",
  "merged",
  "closed",
];

export default function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: task, mutate } = useSWR<Task>(`/api/tasks/${id}`, fetcher, {
    refreshInterval: 5000,
  });
  const { data: config } = useSWR<OrchestratorConfig>("/api/config", fetcher);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Task>>({});
  const [notes, setNotes] = useState<string | undefined>(undefined);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesDirty, setNotesDirty] = useState(false);

  if (!task) return <div className="text-muted-foreground">Loading...</div>;

  function startEdit() {
    setForm({
      title: task!.title,
      description: task!.description,
      plan: task!.plan || "",
      agent: task!.agent,
    });
    setEditing(true);
  }

  async function saveEdit() {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setEditing(false);
    mutate();
  }

  async function updateStatus(status: TaskStatus) {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    mutate();
  }

  async function runNow() {
    await fetch("/api/orchestrator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "poll_now" }),
    });
    mutate();
  }

  async function killSession() {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: id }),
    });
    mutate();
  }

  async function saveNotes() {
    setSavingNotes(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notes || "" }),
    });
    mutate();
    setSavingNotes(false);
  }

  async function deleteTask() {
    const isFinal = task!.status === "merged" || task!.status === "closed";
    if (isFinal) {
      if (!confirm("Delete this task?")) return;
    } else {
      const input = prompt(
        `This task is "${task!.status}". Type "confirm" to delete it.`
      );
      if (input !== "confirm") return;
    }
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    router.push("/");
  }

  const agents = config ? Object.entries(config.agents) : [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {editing ? "Edit Task" : task.title}
        </h1>
        <div className="flex gap-2">
          {!editing && (
            <>
              <Button size="sm" variant="outline" onClick={startEdit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={deleteTask}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={form.title || ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <Select
                value={form.agent || ""}
                onValueChange={(v) => v && setForm({ ...form, agent: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(([key, a]) => (
                    <SelectItem key={key} value={key}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <MdEditor
                value={form.description || ""}
                onChange={(v) => setForm({ ...form, description: v })}
                rows={4}
              />
            </div>
            <div className="space-y-2">
              <Label>Plan (markdown)</Label>
              <MdEditor
                value={form.plan || ""}
                onChange={(v) => setForm({ ...form, plan: v })}
                rows={6}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={saveEdit}>Save</Button>
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Status & Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status & Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Status:
                  </span>
                  <Select
                    value={task.status}
                    onValueChange={(v) => v && updateStatus(v as TaskStatus)}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.replace("_", " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {task.status === "open" && (
                  <Button size="sm" onClick={runNow}>
                    Run Now
                  </Button>
                )}
                {task.current_run_pid && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={killSession}
                  >
                    Kill Session
                  </Button>
                )}
                {task.pr_url && (
                  <a
                    href={task.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button size="sm" variant="outline">
                      View PR
                    </Button>
                  </a>
                )}
                {task.session_id && (
                  <Link href={`/tasks/${id}/session`}>
                    <Button size="sm" variant="outline">
                      View Session
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <span className="text-sm text-muted-foreground">Agent: </span>
                <Badge variant="outline">{task.agent}</Badge>
              </div>
              <div>
                <span className="text-sm text-muted-foreground">
                  Description:
                </span>
                <div className="mt-1 prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{task.description}</ReactMarkdown>
                </div>
              </div>
              {task.plan && (
                <div>
                  <span className="text-sm text-muted-foreground">Plan:</span>
                  <div className="mt-1 prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                    <ReactMarkdown>{task.plan}</ReactMarkdown>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <textarea
                className="w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={notesDirty ? (notes ?? "") : (task.notes ?? "")}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setNotesDirty(true);
                }}
                onBlur={() => {
                  if (notesDirty) {
                    saveNotes();
                    setNotesDirty(false);
                  }
                }}
                placeholder="Add personal notes..."
              />
              {savingNotes && (
                <span className="text-xs text-muted-foreground">Saving...</span>
              )}
            </CardContent>
          </Card>

          {/* Agent Report */}
          {task.last_agent_report && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Agent Report</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    Agent status:
                  </span>
                  <Badge
                    variant={
                      task.last_agent_report.status === "completed"
                        ? "default"
                        : task.last_agent_report.status === "needs_review"
                          ? "secondary"
                          : "destructive"
                    }
                  >
                    {task.last_agent_report.status}
                  </Badge>
                </div>

                <div>
                  <span className="text-sm text-muted-foreground">
                    Summary:
                  </span>
                  <p className="mt-1 whitespace-pre-wrap">
                    {task.last_agent_report.summary}
                  </p>
                </div>

                {task.last_agent_report.files_changed.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Files changed:
                    </span>
                    <ul className="mt-1 list-disc list-inside text-sm font-mono">
                      {task.last_agent_report.files_changed.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {task.last_agent_report.assumptions.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Assumptions made:
                    </span>
                    <ul className="mt-1 list-disc list-inside text-sm">
                      {task.last_agent_report.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {task.last_agent_report.blockers.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Blockers:
                    </span>
                    <ul className="mt-1 list-disc list-inside text-sm text-red-700">
                      {task.last_agent_report.blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {task.last_agent_report.next_steps.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Next steps:
                    </span>
                    <ul className="mt-1 list-disc list-inside text-sm">
                      {task.last_agent_report.next_steps.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Orchestration Metadata */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Orchestration Metadata
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Session ID:</span>
                  <p className="font-mono text-xs">
                    {task.session_id || "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Branch:</span>
                  <p className="font-mono text-xs">
                    {task.branch_name || "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Worktree:</span>
                  <p className="font-mono text-xs">
                    {task.worktree_path || "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Run Count:</span>
                  <p>{task.run_count || 0}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Total Tokens:</span>
                  <p>
                    {(task.total_input_tokens || task.total_output_tokens)
                      ? `${((task.total_input_tokens || 0) + (task.total_output_tokens || 0)).toLocaleString()} (in: ${(task.total_input_tokens || 0).toLocaleString()}, out: ${(task.total_output_tokens || 0).toLocaleString()})`
                      : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Total Time:</span>
                  <p>
                    {task.total_duration_ms
                      ? `${Math.floor(task.total_duration_ms / 60000)}m ${Math.floor((task.total_duration_ms % 60000) / 1000)}s`
                      : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Run:</span>
                  <p>
                    {task.last_run_at
                      ? new Date(task.last_run_at).toLocaleString()
                      : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Result:</span>
                  <p>{task.last_run_result || "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Current PID:</span>
                  <p className="font-mono">
                    {task.current_run_pid || "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>
                  <p>{new Date(task.created_at).toLocaleString()}</p>
                </div>
              </div>

              {task.error_log && task.last_run_result !== "success" && (
                <>
                  <Separator className="my-3" />
                  <div>
                    <span className="text-sm text-muted-foreground">
                      Last Error:
                    </span>
                    <pre className="mt-1 text-xs bg-red-50 text-red-800 p-3 rounded-md whitespace-pre-wrap">
                      {task.error_log}
                    </pre>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
