"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MdEditor } from "@/components/md-editor";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OrchestratorConfig } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AgentsPage() {
  const { data: config, mutate } = useSWR<OrchestratorConfig>(
    "/api/config",
    fetcher
  );
  const { data: templates } = useSWR<{ initial: string; review: string }>(
    "/api/prompts",
    fetcher
  );
  const [showAdd, setShowAdd] = useState(false);
  const [newAgent, setNewAgent] = useState({
    key: "",
    name: "",
    repo_slug: "",
    repo_path: "",
    prompt_file: "",
    default_branch: "main",
    prompt: "",
  });
  const [newEnvVars, setNewEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [showPreview, setShowPreview] = useState(false);

  async function addAgent() {
    if (!config || !newAgent.key || !newAgent.name || !newAgent.repo_path)
      return;
    const { key, prompt, ...agentConfig } = newAgent;
    const prompt_file =
      agentConfig.prompt_file || `.cortex/prompts/agents/${key}.md`;
    const hasEnvVars = newEnvVars.some((v) => v.key.trim());
    const updated = {
      ...config,
      agents: {
        ...config.agents,
        [key]: {
          ...agentConfig,
          prompt_file,
          ...(hasEnvVars ? { env_file: `.env.${key}` } : {}),
        },
      },
    };

    // Save config (creates the agent)
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });

    // Save the prompt file
    if (prompt) {
      await fetch(`/api/agents/${key}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompt }),
      });
    }

    // Save env vars
    if (hasEnvVars) {
      const vars: Record<string, string> = {};
      for (const { key: k, value } of newEnvVars) {
        if (k.trim()) vars[k.trim()] = value;
      }
      await fetch(`/api/agents/${key}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars }),
      });
    }

    mutate();
    setNewAgent({
      key: "",
      name: "",
      repo_slug: "",
      repo_path: "",
      prompt_file: "",
      default_branch: "main",
      prompt: "",
    });
    setNewEnvVars([]);
    setShowAdd(false);
  }

  async function removeAgent(key: string) {
    if (!config || !confirm(`Remove agent "${key}"?`)) return;
    const agents = { ...config.agents };
    delete agents[key];
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, agents }),
    });
    mutate();
  }

  // Build preview of the full prompt Claude will receive
  const fullPreview = templates?.initial
    .replace("{{TASK_TITLE}}", "(task title)")
    .replace("{{TASK_DESCRIPTION}}", "(task description)")
    .replace("{{TASK_PLAN}}", "(task plan or 'No detailed plan provided')")
    .replace("{{AGENT_NAME}}", newAgent.name || "(agent name)")
    .replace(
      "{{REPO_CONTEXT}}",
      newAgent.prompt || "(your agent prompt will appear here)"
    );

  const agents = config ? Object.entries(config.agents) : [];

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Agents</h1>
        <Button onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "New Agent"}
        </Button>
      </div>

      {showAdd && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Create Agent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Agent ID (unique key)</Label>
                <Input
                  value={newAgent.key}
                  onChange={(e) =>
                    setNewAgent({ ...newAgent, key: e.target.value })
                  }
                  placeholder="acme-bugfixer"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Display Name</Label>
                <Input
                  value={newAgent.name}
                  onChange={(e) =>
                    setNewAgent({ ...newAgent, name: e.target.value })
                  }
                  placeholder="Acme Bug Fixer"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Repo Slug (owner/repo)</Label>
                <Input
                  value={newAgent.repo_slug}
                  onChange={(e) =>
                    setNewAgent({ ...newAgent, repo_slug: e.target.value })
                  }
                  placeholder="owner/repo"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Repo Local Path</Label>
                <Input
                  value={newAgent.repo_path}
                  onChange={(e) =>
                    setNewAgent({ ...newAgent, repo_path: e.target.value })
                  }
                  placeholder="/path/to/local/repo"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Default Branch</Label>
                <Input
                  value={newAgent.default_branch}
                  onChange={(e) =>
                    setNewAgent({
                      ...newAgent,
                      default_branch: e.target.value,
                    })
                  }
                  placeholder="main"
                />
              </div>
            </div>

            {/* Env Vars */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  Environment Variables{" "}
                  <span className="text-muted-foreground">
                    (secrets — not committed)
                  </span>
                </Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setNewEnvVars([...newEnvVars, { key: "", value: "" }])
                  }
                >
                  Add Variable
                </Button>
              </div>
              {newEnvVars.map((entry, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input
                    value={entry.key}
                    onChange={(e) => {
                      const updated = [...newEnvVars];
                      updated[i] = { ...entry, key: e.target.value };
                      setNewEnvVars(updated);
                    }}
                    placeholder="KEY"
                    className="font-mono text-sm w-44"
                  />
                  <span className="text-muted-foreground">=</span>
                  <Input
                    value={entry.value}
                    onChange={(e) => {
                      const updated = [...newEnvVars];
                      updated[i] = { ...entry, value: e.target.value };
                      setNewEnvVars(updated);
                    }}
                    placeholder="value"
                    className="font-mono text-sm flex-1"
                    type="password"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() =>
                      setNewEnvVars(newEnvVars.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            <Separator />

            {/* Agent Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Agent Prompt</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? "Hide full prompt" : "Show full prompt"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This is your agent-specific instructions. It gets appended as
                &quot;Repository Context&quot; at the end of a fixed template
                that includes the task details and general instructions.
              </p>

              {showPreview ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Full prompt preview (your prompt is highlighted):
                  </p>
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-4 rounded-md overflow-auto max-h-[500px] leading-relaxed">
                    {fullPreview
                      ?.split(
                        newAgent.prompt || "(your agent prompt will appear here)"
                      )
                      .map((part, i, arr) => (
                        <span key={i}>
                          {part}
                          {i < arr.length - 1 && (
                            <span className="bg-blue-100 text-blue-900 px-0.5 rounded">
                              {newAgent.prompt ||
                                "(your agent prompt will appear here)"}
                            </span>
                          )}
                        </span>
                      ))}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    A JSON schema is also enforced requiring the agent to return:
                    status, summary, pr_url, branch_name, files_changed,
                    assumptions, blockers, next_steps.
                  </p>
                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Review prompt (used for all agents when addressing PR
                    feedback):
                  </p>
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-4 rounded-md overflow-auto max-h-[300px] leading-relaxed">
                    {templates?.review || "Loading..."}
                  </pre>
                </div>
              ) : (
                <MdEditor
                  value={newAgent.prompt}
                  onChange={(v) =>
                    setNewAgent({ ...newAgent, prompt: v })
                  }
                  rows={12}
                  placeholder={`# ${newAgent.name || "Agent Name"}\n\n## Architecture\nDescribe the codebase structure...\n\n## Coding Conventions\nList style rules, patterns...\n\n## Test Commands\nnpm test, pytest, etc.\n\n## Important Notes\nAnything the agent should know...`}
                />
              )}
            </div>

            <Button
              onClick={addAgent}
              disabled={!newAgent.key || !newAgent.name || !newAgent.repo_path}
            >
              Create Agent
            </Button>
          </CardContent>
        </Card>
      )}

      {agents.length === 0 && !showAdd && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No agents configured. Create one to get started.
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {agents.map(([key, agent]) => (
          <Card key={key}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/agents/${key}`}
                      className="font-medium hover:underline"
                    >
                      {agent.name}
                    </Link>
                    <Badge variant="outline" className="text-xs">
                      {key}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {agent.repo_slug} &middot; {agent.repo_path}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Prompt: {agent.prompt_file || "none"} &middot; Branch:{" "}
                    {agent.default_branch}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/agents/${key}`}>
                    <Button size="sm" variant="outline">
                      Edit
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => removeAgent(key)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
