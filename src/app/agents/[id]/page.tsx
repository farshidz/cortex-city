"use client";

import { use, useState, useEffect } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MdEditor } from "@/components/md-editor";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OrchestratorConfig } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: config, mutate: mutateConfig } =
    useSWR<OrchestratorConfig>("/api/config", fetcher);
  const { data: promptData, mutate: mutatePrompt } = useSWR<{
    content: string;
  }>(`/api/agents/${id}/prompt`, fetcher);
  const { data: templates } = useSWR<{
    initial: string;
    review: string;
  }>("/api/prompts", fetcher);

  const { data: envData, mutate: mutateEnv } = useSWR<{
    vars: Record<string, string>;
    path: string | null;
  }>(`/api/agents/${id}/env`, fetcher);

  const [promptContent, setPromptContent] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [configForm, setConfigForm] = useState({
    name: "",
    repo_slug: "",
    repo_path: "",
    default_branch: "",
  });
  const [activeTab, setActiveTab] = useState("agent");
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);

  const agent = config?.agents[id];

  useEffect(() => {
    if (!promptData || promptLoaded) return;
    const handle = requestAnimationFrame(() => {
      setPromptContent(promptData.content);
      setPromptLoaded(true);
    });
    return () => cancelAnimationFrame(handle);
  }, [promptData, promptLoaded]);

  useEffect(() => {
    if (!envData || envLoaded) return;
    const handle = requestAnimationFrame(() => {
      const entries = Object.entries(envData.vars).map(([key, value]) => ({
        key,
        value,
      }));
      setEnvVars(entries.length > 0 ? entries : [{ key: "", value: "" }]);
      setEnvLoaded(true);
    });
    return () => cancelAnimationFrame(handle);
  }, [envData, envLoaded]);

  if (!config) return <div className="text-muted-foreground">Loading...</div>;
  if (!agent)
    return (
      <div className="text-muted-foreground">
        Agent &quot;{id}&quot; not found.
      </div>
    );

  function startEditConfig() {
    setConfigForm({
      name: agent!.name,
      repo_slug: agent!.repo_slug,
      repo_path: agent!.repo_path,
      default_branch: agent!.default_branch,
    });
    setEditingConfig(true);
  }

  async function saveConfig() {
    const updated = {
      ...config,
      agents: {
        ...config!.agents,
        [id]: { ...agent!, ...configForm },
      },
    };
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    mutateConfig();
    setEditingConfig(false);
  }

  async function saveEnv() {
    setSavingEnv(true);
    const vars: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) vars[key.trim()] = value;
    }
    await fetch(`/api/agents/${id}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vars }),
    });
    mutateEnv();
    setSavingEnv(false);
  }

  async function savePrompt() {
    setSaving(true);
    await fetch(`/api/agents/${id}/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: promptContent }),
    });
    mutatePrompt();
    setSaving(false);
  }

  // Build preview of what Claude actually receives
  const initialPreview = templates?.initial
    .replace("{{TASK_TITLE}}", "(task title)")
    .replace("{{TASK_DESCRIPTION}}", "(task description)")
    .replace("{{TASK_PLAN}}", "(task plan or 'No detailed plan provided')")
    .replace("{{AGENT_NAME}}", agent?.name || id)
    .replace(
      "{{REPO_CONTEXT}}",
      promptContent || "(your agent prompt goes here)"
    );

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <Badge variant="outline">{id}</Badge>
        </div>
        <Button variant="outline" onClick={() => router.push("/agents")}>
          Back
        </Button>
      </div>

      {/* Agent Config */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Configuration</CardTitle>
            {!editingConfig && (
              <Button size="sm" variant="outline" onClick={startEditConfig}>
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editingConfig ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Display Name</Label>
                  <Input
                    value={configForm.name}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Repo Slug</Label>
                  <Input
                    value={configForm.repo_slug}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        repo_slug: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Repo Local Path</Label>
                  <Input
                    value={configForm.repo_path}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        repo_path: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Default Branch</Label>
                  <Input
                    value={configForm.default_branch}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        default_branch: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveConfig}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingConfig(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Repo: </span>
                {agent.repo_slug}
              </div>
              <div>
                <span className="text-muted-foreground">Path: </span>
                <span className="font-mono text-xs">{agent.repo_path}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Branch: </span>
                {agent.default_branch}
              </div>
              <div>
                <span className="text-muted-foreground">Prompt file: </span>
                <span className="font-mono text-xs">{agent.prompt_file}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Environment Variables */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Environment Variables</CardTitle>
            <Badge variant="secondary" className="text-xs">
              Not committed to git
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            These are passed as environment variables when Claude runs. Stored
            locally in{" "}
            <code className="bg-muted px-1 rounded">
              {agent.env_file || `.env.${id}`}
            </code>{" "}
            and never committed to git. A global{" "}
            <code className="bg-muted px-1 rounded">.env</code> is also loaded
            first if it exists.
          </p>
          <div className="space-y-2">
            {envVars.map((entry, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  value={entry.key}
                  onChange={(e) => {
                    const updated = [...envVars];
                    updated[i] = { ...entry, key: e.target.value };
                    setEnvVars(updated);
                  }}
                  placeholder="KEY"
                  className="font-mono text-sm w-48"
                />
                <span className="text-muted-foreground">=</span>
                <Input
                  value={entry.value}
                  onChange={(e) => {
                    const updated = [...envVars];
                    updated[i] = { ...entry, value: e.target.value };
                    setEnvVars(updated);
                  }}
                  placeholder="value"
                  className="font-mono text-sm flex-1"
                  type="password"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    const updated = envVars.filter((_, j) => j !== i);
                    setEnvVars(
                      updated.length > 0 ? updated : [{ key: "", value: "" }]
                    );
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEnvVars([...envVars, { key: "", value: "" }])
              }
            >
              Add Variable
            </Button>
            <Button size="sm" onClick={saveEnv} disabled={savingEnv}>
              {savingEnv ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Prompt Editor + Template Viewer */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompts</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-4">
            <TabsList>
              <TabsTrigger value="agent">Agent Prompt</TabsTrigger>
              <TabsTrigger value="preview">Full Initial Prompt</TabsTrigger>
              <TabsTrigger value="review">Review Prompt (fixed)</TabsTrigger>
            </TabsList>
          </Tabs>

          {activeTab === "agent" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This is the agent-specific prompt appended as &quot;Repository
                Context&quot; at the end of the initial prompt template. Use it
                to describe coding conventions, architecture, test commands, and
                anything unique to this agent&apos;s role.
              </p>
              <MdEditor
                value={promptContent}
                onChange={setPromptContent}
                rows={16}
                placeholder={`# ${agent.name}\n\n## Architecture\n...\n\n## Coding Conventions\n...\n\n## Test Commands\n...\n\n## Important Notes\n...`}
              />
              <div className="flex gap-2">
                <Button onClick={savePrompt} disabled={saving}>
                  {saving ? "Saving..." : "Save Prompt"}
                </Button>
                {promptData?.content !== promptContent && (
                  <span className="text-sm text-muted-foreground self-center">
                    Unsaved changes
                  </span>
                )}
              </div>
            </div>
          )}

          {activeTab === "preview" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This is the full prompt Claude receives for new tasks. The
                fixed template parts are shown in normal text. Your agent
                prompt is inserted at{" "}
                <code className="bg-muted px-1 rounded">
                  {"{{REPO_CONTEXT}}"}
                </code>
                .
              </p>
              <div className="relative">
                <pre className="whitespace-pre-wrap text-sm bg-muted p-4 rounded-md overflow-auto max-h-[600px] leading-relaxed">
                  {initialPreview || "Loading..."}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground">
                Additionally, a JSON schema is enforced via{" "}
                <code className="bg-muted px-1 rounded">--json-schema</code>{" "}
                requiring the agent to return: status, summary, pr_url,
                branch_name, files_changed, assumptions, blockers, next_steps.
              </p>
            </div>
          )}

          {activeTab === "review" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This fixed prompt is used when the orchestrator detects open PR
                comments or failing CI on a task in review. The placeholders are
                filled with live PR data. This prompt is the same for all agents.
              </p>
              <pre className="whitespace-pre-wrap text-sm bg-muted p-4 rounded-md overflow-auto max-h-[600px] leading-relaxed">
                {templates?.review || "Loading..."}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
