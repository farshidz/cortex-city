"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MdEditor } from "@/components/md-editor";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentRuntime, OrchestratorConfig, PermissionMode } from "@/lib/types";

export default function NewTaskPage() {
  const router = useRouter();
  const [config, setConfig] = useState<OrchestratorConfig | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState("");
  const [agent, setAgent] = useState("");
  const [branchName, setBranchName] = useState("");
  const [agentRunner, setAgentRunner] = useState<AgentRuntime | "">("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        setConfig(cfg);
        setAgentRunner((prev) => prev || cfg.default_agent_runner);
        setPermissionMode((prev) => prev || cfg.default_permission_mode);
      });
  }, []);

  useEffect(() => {
    if (!config) return;
    const runner = agentRunner || config.default_agent_runner;
    const allowed =
      runner === "codex"
        ? (["default", "yolo"] as PermissionMode[])
        : (["bypassPermissions", "acceptEdits", "default"] as PermissionMode[]);
    const handle = requestAnimationFrame(() => {
      setPermissionMode((prev) =>
        prev && allowed.includes(prev)
          ? prev
          : (allowed[0] as PermissionMode)
      );
    });
    return () => cancelAnimationFrame(handle);
  }, [agentRunner, config]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !agent) return;
    setSubmitting(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        plan: plan || undefined,
        agent,
        branch_name: branchName || undefined,
        agent_runner: agentRunner || config?.default_agent_runner,
        permission_mode: permissionMode || config?.default_permission_mode,
      }),
    });
    router.push("/");
  }

  const agents = config ? Object.entries(config.agents) : [];

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">New Task</h1>
      <Card>
        <CardHeader>
          <CardTitle>Create a new task</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Fix the authentication bug in..."
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent">Agent</Label>
              <Select value={agent} onValueChange={(v) => setAgent(v ?? "")} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(([key, a]) => (
                    <SelectItem key={key} value={key}>
                      {a.name} ({a.repo_slug})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agents.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No agents configured.{" "}
                  <a href="/settings" className="underline">
                    Add one in Settings
                  </a>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="runtime">Agent Runtime</Label>
              <Select
                value={agentRunner || undefined}
                onValueChange={(v) => v && setAgentRunner(v as AgentRuntime)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Defaults to {config?.default_agent_runner || "claude"} if not set.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="permission">Permission Mode</Label>
              <Select
                value={permissionMode || undefined}
                onValueChange={(v) =>
                  v && setPermissionMode(v as PermissionMode)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use default" />
                </SelectTrigger>
                <SelectContent>
                  {(agentRunner || config?.default_agent_runner || "claude") === "codex" ? (
                    <>
                      <SelectItem value="default">Prompt for every action</SelectItem>
                      <SelectItem value="yolo">YOLO (no prompts)</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="bypassPermissions">Bypass Permissions</SelectItem>
                      <SelectItem value="acceptEdits">Accept Edits</SelectItem>
                      <SelectItem value="default">Default</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Defaults to {config?.default_permission_mode || "bypassPermissions"} if not set.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <MdEditor
                value={description}
                onChange={setDescription}
                placeholder="Describe what the agent should do..."
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="plan">
                Plan{" "}
                <span className="text-muted-foreground font-normal">
                  (optional, markdown)
                </span>
              </Label>
              <MdEditor
                value={plan}
                onChange={setPlan}
                placeholder="Detailed implementation plan..."
                rows={6}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branch">
                Branch{" "}
                <span className="text-muted-foreground font-normal">
                  (optional — use existing branch instead of creating new)
                </span>
              </Label>
              <Input
                id="branch"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="feature/my-existing-branch"
              />
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={submitting || !title || !agent}>
                {submitting ? "Creating..." : "Create Task"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/")}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
