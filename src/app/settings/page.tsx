"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentRuntime,
  ClaudeEffort,
  CodexEffort,
  OrchestratorConfig,
  PermissionMode,
  TaskEffort,
} from "@/lib/types";
import { getEffortOptions, getPermissionOptions } from "@/lib/runtime-config";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const UNSET_VALUE = "__unset__";

interface ReviewLearningsResponse {
  content: string;
  enabled: boolean;
}

export default function SettingsPage() {
  const { data: config, mutate } = useSWR<OrchestratorConfig>(
    "/api/config",
    fetcher
  );
  const { data: learnings, mutate: mutateLearnings } =
    useSWR<ReviewLearningsResponse>("/api/reviews/learnings", fetcher);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<OrchestratorConfig | null>(null);
  const [learningsEditing, setLearningsEditing] = useState(false);
  const [learningsSaving, setLearningsSaving] = useState(false);
  const [learningsContent, setLearningsContent] = useState("");
  const permissionOptions = form
    ? getPermissionOptions(form.default_agent_runner)
    : [];

  useEffect(() => {
    if (!config || form) return;
    const handle = requestAnimationFrame(() => setForm(config));
    return () => cancelAnimationFrame(handle);
  }, [config, form]);

  useEffect(() => {
    if (!learnings || learningsEditing) return;
    const handle = requestAnimationFrame(() =>
      setLearningsContent(learnings.content)
    );
    return () => cancelAnimationFrame(handle);
  }, [learnings, learningsEditing]);

  function handleRunnerChange(value: string) {
    if (!form) return;
    if (value !== "claude" && value !== "codex") return;
    const nextPermission = getPermissionOptions(value).some(
      (option) => option.value === form.default_permission_mode
    )
      ? form.default_permission_mode
      : (getPermissionOptions(value)[0].value as PermissionMode);
    setForm({
      ...form,
      default_agent_runner: value,
      default_permission_mode: nextPermission,
    });
  }

  async function saveConfig() {
    if (!form) return;
    setSaving(true);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    mutate();
    setSaving(false);
  }

  async function saveLearnings() {
    setLearningsSaving(true);
    await fetch("/api/reviews/learnings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: learningsContent }),
    });
    await mutateLearnings();
    setLearningsEditing(false);
    setLearningsSaving(false);
  }

  if (!form) return <div className="text-muted-foreground">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Orchestrator Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Orchestrator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Max Parallel Sessions</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={form.max_parallel_sessions}
              onChange={(e) =>
                setForm({
                  ...form,
                  max_parallel_sessions: parseInt(e.target.value) || 1,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Poll Interval (seconds)</Label>
            <Input
              type="number"
              min={10}
              max={600}
              value={form.poll_interval_seconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  poll_interval_seconds: parseInt(e.target.value) || 30,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Default Agent Runtime</Label>
            <Select
              value={form.default_agent_runner}
              onValueChange={(v) => v && handleRunnerChange(v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Default Permission Mode</Label>
            <Select
              value={form.default_permission_mode}
              onValueChange={(v) =>
                v &&
                setForm({
                  ...form,
                  default_permission_mode: v,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {permissionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claude Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Default Claude Model</Label>
            <Input
              value={form.default_claude_model || ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  default_claude_model: e.target.value || undefined,
                })
              }
              placeholder="claude-sonnet-4-6"
            />
          </div>
          <div className="space-y-2">
            <Label>Default Claude Effort</Label>
            <Select
              value={form.default_claude_effort || UNSET_VALUE}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  default_claude_effort:
                    v === UNSET_VALUE ? undefined : (v as ClaudeEffort),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_VALUE}>CLI default</SelectItem>
                {getEffortOptions("claude").map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Codex Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Default Codex Model</Label>
            <Input
              value={form.default_codex_model || ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  default_codex_model: e.target.value || undefined,
                })
              }
              placeholder="gpt-5.4"
            />
          </div>
          <div className="space-y-2">
            <Label>Default Codex Effort</Label>
            <Select
              value={form.default_codex_effort || UNSET_VALUE}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  default_codex_effort:
                    v === UNSET_VALUE ? undefined : (v as CodexEffort),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_VALUE}>CLI default</SelectItem>
                {getEffortOptions("codex").map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review Summaries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Review Summary Prompt</Label>
            <Textarea
              rows={8}
              value={form.review_prompt ?? ""}
              placeholder="Default summary prompt will be used if left blank."
              onChange={(e) =>
                setForm({
                  ...form,
                  review_prompt: e.target.value || undefined,
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Default Review Summary Runtime</Label>
            <Select
              value={form.review_runtime || form.default_agent_runner}
              onValueChange={(v) =>
                v &&
                setForm({
                  ...form,
                  review_runtime: v as AgentRuntime,
                  review_effort: undefined,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Default Review Summary Effort</Label>
            <Select
              value={form.review_effort || UNSET_VALUE}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  review_effort:
                    v === UNSET_VALUE ? undefined : (v as TaskEffort),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_VALUE}>CLI default</SelectItem>
                {getEffortOptions(
                  form.review_runtime || form.default_agent_runner
                ).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Max Parallel Review Summary Runs</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={form.max_parallel_reviews ?? 2}
              onChange={(e) =>
                setForm({
                  ...form,
                  max_parallel_reviews: parseInt(e.target.value) || 1,
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.review_learning_enabled !== false}
              onCheckedChange={(checked) =>
                setForm({
                  ...form,
                  review_learning_enabled: checked,
                })
              }
            />
            <Label>Learning enabled</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Review learnings</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLearningsEditing((value) => !value)}
            >
              {learningsEditing ? "Cancel" : "Edit"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {learningsEditing ? (
            <>
              <Textarea
                rows={10}
                value={learningsContent}
                onChange={(e) => setLearningsContent(e.target.value)}
              />
              <Button
                type="button"
                onClick={saveLearnings}
                disabled={learningsSaving}
              >
                {learningsSaving ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
              {learnings?.content?.trim() || "No review learnings recorded yet."}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reviewer Agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Reviewer Agent Instructions</Label>
            <Textarea
              rows={6}
              value={form.reviewer_agent_prompt ?? ""}
              placeholder="Optional instructions appended to the reviewer agent prompt."
              onChange={(e) =>
                setForm({
                  ...form,
                  reviewer_agent_prompt: e.target.value || undefined,
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <Button onClick={saveConfig} disabled={saving}>
        {saving ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
