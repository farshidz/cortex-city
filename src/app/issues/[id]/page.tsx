"use client";

import { use, useState } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MdEditor } from "@/components/md-editor";
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
import type { Issue, IssueStatus, LinkedTaskSummary } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const ALL_STATUSES: IssueStatus[] = ["open", "in_progress", "done", "closed"];

type IssueDetail = Issue & { linked_task?: LinkedTaskSummary };

export default function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: issue, mutate } = useSWR<IssueDetail>(
    `/api/issues/${id}`,
    fetcher,
    { refreshInterval: 5000 }
  );

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ title: string; description: string; plan: string }>(
    { title: "", description: "", plan: "" }
  );
  const [commentDraft, setCommentDraft] = useState("");
  const [addingComment, setAddingComment] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function startEdit() {
    if (!issue) return;
    setForm({
      title: issue.title,
      description: issue.description,
      plan: issue.plan ?? "",
    });
    setEditing(true);
  }

  async function saveEdit() {
    await fetch(`/api/issues/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title,
        description: form.description,
        plan: form.plan,
      }),
    });
    setEditing(false);
    mutate();
  }

  async function updateStatus(status: IssueStatus) {
    await fetch(`/api/issues/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    mutate();
  }

  async function submitComment() {
    const trimmed = commentDraft.trim();
    if (!trimmed) return;
    setAddingComment(true);
    await fetch(`/api/issues/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: trimmed }),
    });
    setCommentDraft("");
    setAddingComment(false);
    mutate();
  }

  async function deleteIssue() {
    if (!confirm("Delete this issue?")) return;
    const res = await fetch(`/api/issues/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setDeleteError(body.error || "Failed to delete issue");
      return;
    }
    router.push("/issues");
  }

  if (!issue) return <div className="text-muted-foreground">Loading...</div>;

  const isResolved = issue.status === "done" || issue.status === "closed";
  const canCreateTask = !issue.task_id && !isResolved;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {editing ? "Edit Issue" : issue.title}
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
                onClick={deleteIssue}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {deleteError && (
        <div className="rounded-md border border-destructive bg-destructive/10 text-destructive text-sm p-3">
          {deleteError}
        </div>
      )}

      {editing ? (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <MdEditor
                value={form.description}
                onChange={(v) => setForm({ ...form, description: v })}
                rows={4}
              />
            </div>
            <div className="space-y-2">
              <Label>Plan (markdown)</Label>
              <MdEditor
                value={form.plan}
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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status & Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Select
                    value={issue.status}
                    onValueChange={(v) => v && updateStatus(v as IssueStatus)}
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

                <Link
                  href={canCreateTask ? `/tasks/new?issue_id=${issue.id}` : "#"}
                  aria-disabled={!canCreateTask}
                  tabIndex={canCreateTask ? undefined : -1}
                  onClick={(e) => {
                    if (!canCreateTask) e.preventDefault();
                  }}
                >
                  <Button size="sm" disabled={!canCreateTask}>
                    Create Task
                  </Button>
                </Link>

                {isResolved && !issue.task_id && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateStatus("open")}
                  >
                    Reopen
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <span className="text-sm text-muted-foreground">Description:</span>
                <div className="mt-1 prose prose-sm dark:prose-invert max-w-none">
                  {issue.description ? (
                    <ReactMarkdown>{issue.description}</ReactMarkdown>
                  ) : (
                    <p className="text-muted-foreground italic">No description</p>
                  )}
                </div>
              </div>
              {issue.plan && (
                <div>
                  <span className="text-sm text-muted-foreground">Plan:</span>
                  <div className="mt-1 prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                    <ReactMarkdown>{issue.plan}</ReactMarkdown>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                <span>Created: {new Date(issue.created_at).toLocaleString()}</span>
                <span>Updated: {new Date(issue.updated_at).toLocaleString()}</span>
              </div>
            </CardContent>
          </Card>

          {issue.linked_task && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Linked Task</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <Link
                      href={`/tasks/${issue.linked_task.id}`}
                      className="font-medium hover:underline"
                    >
                      {issue.linked_task.title}
                    </Link>
                    <div className="text-xs text-muted-foreground font-mono">
                      {issue.linked_task.id}
                    </div>
                  </div>
                  <Badge variant="outline">
                    {issue.linked_task.status.replace("_", " ")}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {issue.comments.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  No comments yet.
                </p>
              ) : (
                <ul className="space-y-3">
                  {issue.comments.map((comment) => (
                    <li
                      key={comment.id}
                      className="rounded-md border p-3 space-y-1"
                    >
                      <div className="text-xs text-muted-foreground">
                        {new Date(comment.created_at).toLocaleString()}
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{comment.body}</ReactMarkdown>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-2">
                <Label htmlFor="comment">Add comment</Label>
                <textarea
                  id="comment"
                  className="w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="Markdown supported..."
                />
                <Button
                  size="sm"
                  onClick={submitComment}
                  disabled={addingComment || !commentDraft.trim()}
                >
                  {addingComment ? "Adding..." : "Add comment"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
