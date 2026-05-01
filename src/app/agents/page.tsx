"use client";

import { useState } from "react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OrchestratorConfig, PromptMode } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function buildPromptSection(title: string, content?: string): string {
  if (!content?.trim()) return "";
  return `## ${title}\n${content.trim()}\n`;
}

function buildGitIdentityPreview(name?: string, email?: string): string {
  const trimmedName = name?.trim();
  const trimmedEmail = email?.trim();
  if (!trimmedName || !trimmedEmail) {
    return "";
  }
  return [
    "## Git Author Identity",
    "Before creating commits, configure the worktree to use this Git author identity:",
    "",
    "```bash",
    `git config user.name '${trimmedName.replace(/'/g, "'\\''")}'`,
    `git config user.email '${trimmedEmail.replace(/'/g, "'\\''")}'`,
    "```",
    "",
    "Commit as this name and email for this task. Do not invent or substitute another author identity.",
    "",
  ].join("\n");
}

export default function AgentsPage() {
  const { data: config, mutate } = useSWR<OrchestratorConfig>(
    "/api/config",
    fetcher
  );
  const { data: templates } = useSWR<{
    initial: string;
    review: string;
    cleanup: string;
  }>("/api/prompts", fetcher);
  const [showAdd, setShowAdd] = useState(false);
  const [newAgent, setNewAgent] = useState({
    key: "",
    name: "",
    repo_slug: "",
    repo_path: "",
    prompt_file: "",
    default_branch: "main",
    git_user_name: "",
    git_user_email: "",
    description: "",
  });
  const [promptContent, setPromptContent] = useState<Record<PromptMode, string>>({
    initial: "",
    review: "",
    cleanup: "",
  });
  const [promptTab, setPromptTab] = useState<PromptMode>("initial");
  const [newEnvVars, setNewEnvVars] = useState<{ key: string; value: string }[]>(
    []
  );
  const [showPreview, setShowPreview] = useState(false);

  async function addAgent() {
    if (!config || !newAgent.key || !newAgent.name || !newAgent.repo_path) return;

    const { key, ...agentConfig } = newAgent;
    const promptFile = agentConfig.prompt_file || `.cortex/prompts/agents/${key}.md`;
    const reviewPromptFile = `.cortex/prompts/agents/${key}.review.md`;
    const cleanupPromptFile = `.cortex/prompts/agents/${key}.cleanup.md`;
    const hasEnvVars = newEnvVars.some((v) => v.key.trim());
    const updated = {
      ...config,
      agents: {
        ...config.agents,
        [key]: {
          ...agentConfig,
          prompt_file: promptFile,
          ...(promptContent.review.trim()
            ? { review_prompt_file: reviewPromptFile }
            : {}),
          ...(promptContent.cleanup.trim()
            ? { cleanup_prompt_file: cleanupPromptFile }
            : {}),
        },
      },
    };

    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });

    if (promptContent.initial) {
      await fetch(`/api/agents/${key}/prompt?mode=initial`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: promptContent.initial }),
      });
    }
    if (promptContent.review) {
      await fetch(`/api/agents/${key}/prompt?mode=review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: promptContent.review }),
      });
    }
    if (promptContent.cleanup) {
      await fetch(`/api/agents/${key}/prompt?mode=cleanup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: promptContent.cleanup }),
      });
    }

    if (hasEnvVars) {
      const vars: Record<string, string> = {};
      for (const { key: envKey, value } of newEnvVars) {
        if (envKey.trim()) vars[envKey.trim()] = value;
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
      git_user_name: "",
      git_user_email: "",
      description: "",
    });
    setPromptContent({
      initial: "",
      review: "",
      cleanup: "",
    });
    setPromptTab("initial");
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

  function buildPreview(mode: PromptMode): string {
    if (!templates) return "Loading...";
    const template = templates[mode];
    if (mode === "initial") {
      return template
        .replace("{{TASK_TITLE}}", "(task title)")
        .replace("{{TASK_DESCRIPTION}}", "(task description)")
        .replace("{{TASK_PLAN}}", "(task plan or 'No detailed plan provided')")
        .replace("{{AGENT_NAME}}", newAgent.name || "(agent name)")
        .replace(/\{\{BASE_BRANCH\}\}/g, newAgent.default_branch || "main")
        .replace(
          "{{GIT_IDENTITY_SECTION}}",
          buildGitIdentityPreview(newAgent.git_user_name, newAgent.git_user_email)
        )
        .replace(
          "{{REPO_CONTEXT_SECTION}}",
          buildPromptSection(
            "Repository Context",
            promptContent.initial || "(your initial prompt will appear here)"
          )
        )
        .replace("{{AGENT_DIRECTORY}}", "(agents list will appear here)");
    }
    if (mode === "review") {
      return template
        .replace("{{PR_URL}}", "(pr url)")
        .replace("{{AGENT_NAME}}", newAgent.name || "(agent name)")
        .replace("{{MERGE_STATUS}}", "(merge status)")
        .replace(
          "{{GIT_IDENTITY_SECTION}}",
          buildGitIdentityPreview(newAgent.git_user_name, newAgent.git_user_email)
        )
        .replace(/\{\{BASE_BRANCH\}\}/g, newAgent.default_branch || "main")
        .replace(
          "{{REPO_CONTEXT_SECTION}}",
          buildPromptSection(
            "Agent Review Context",
            promptContent.review || "(optional review prompt will appear here)"
          )
        )
        .replace("{{AGENT_DIRECTORY}}", "(agents list will appear here)");
    }
    return template
      .replace(/\{\{FINAL_STATUS\}\}/g, "(final status)")
      .replace("{{TASK_TITLE}}", "(task title)")
      .replace("{{TASK_DESCRIPTION}}", "(task description)")
      .replace("{{PR_URL}}", "(pr url)")
      .replace("{{BRANCH_NAME}}", "(branch name)")
      .replace(
        "{{REPO_CONTEXT_SECTION}}",
        buildPromptSection(
          "Agent Cleanup Context",
          promptContent.cleanup || "(optional cleanup prompt will appear here)"
        )
      )
      .replace("{{AGENT_DIRECTORY}}", "(agents list will appear here)");
  }

  const agents = config ? Object.entries(config.agents) : [];
  const promptPath =
    promptTab === "initial"
      ? newAgent.prompt_file || `.cortex/prompts/agents/${newAgent.key || "<agent-id>"}.md`
      : promptTab === "review"
        ? `.cortex/prompts/agents/${newAgent.key || "<agent-id>"}.review.md`
        : `.cortex/prompts/agents/${newAgent.key || "<agent-id>"}.cleanup.md`;

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
              <div className="space-y-1">
                <Label className="text-xs">Git Author Name</Label>
                <Input
                  value={newAgent.git_user_name}
                  onChange={(e) =>
                    setNewAgent({
                      ...newAgent,
                      git_user_name: e.target.value,
                    })
                  }
                  placeholder="Use repo or machine config"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Git Author Email</Label>
                <Input
                  value={newAgent.git_user_email}
                  onChange={(e) =>
                    setNewAgent({
                      ...newAgent,
                      git_user_email: e.target.value,
                    })
                  }
                  placeholder="Use repo or machine config"
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Description</Label>
                <textarea
                  className="w-full min-h-[90px] rounded-md border bg-transparent px-3 py-2 text-sm"
                  value={newAgent.description}
                  onChange={(e) =>
                    setNewAgent({ ...newAgent, description: e.target.value })
                  }
                  placeholder="Short summary of when to use this agent"
                />
              </div>
            </div>

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

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Agent Prompts</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? "Hide full prompt" : "Show full prompt"}
                </Button>
              </div>
              <Tabs
                value={promptTab}
                onValueChange={(value) => setPromptTab(value as PromptMode)}
              >
                <TabsList>
                  <TabsTrigger value="initial">Initial</TabsTrigger>
                  <TabsTrigger value="review">Review</TabsTrigger>
                  <TabsTrigger value="cleanup">Cleanup</TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">
                {promptTab === "initial"
                  ? "Initial prompts are appended to new-task runs as repository context."
                  : promptTab === "review"
                    ? "Review prompts are optional and are appended only when the task is revisited for PR feedback."
                    : "Cleanup prompts are optional and are appended only when the task is cleaning up after merge or close."}
              </p>
              <p className="text-xs text-muted-foreground">
                Will be stored at{" "}
                <code className="bg-muted px-1 rounded">{promptPath}</code>.
              </p>

              {showPreview ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Full prompt preview
                  </p>
                  <pre className="whitespace-pre-wrap text-xs bg-muted p-4 rounded-md overflow-auto max-h-[500px] leading-relaxed">
                    {buildPreview(promptTab)}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    A JSON schema is also enforced requiring: status, summary,
                    pr_url, branch_name, files_changed, assumptions, blockers,
                    next_steps, and optional tool_calls.
                  </p>
                </div>
              ) : (
                <MdEditor
                  value={promptContent[promptTab]}
                  onChange={(value) =>
                    setPromptContent((current) => ({
                      ...current,
                      [promptTab]: value,
                    }))
                  }
                  rows={12}
                  placeholder={
                    promptTab === "initial"
                      ? `# ${newAgent.name || "Agent Name"}\n\n## Architecture\nDescribe the codebase structure...\n\n## Coding Conventions\nList style rules, patterns...\n\n## Test Commands\nnpm test, pytest, etc.\n\n## Important Notes\nAnything the agent should know...`
                      : promptTab === "review"
                        ? `# ${newAgent.name || "Agent Name"} Review Notes\n\n## Review Priorities\nHow this agent should process feedback...\n\n## Common Failure Modes\nWhat to look for on review runs...\n\n## Verification Commands\nCommands to rerun before replying...`
                        : `# ${newAgent.name || "Agent Name"} Cleanup Notes\n\n## Cleanup Checklist\nBranch, environments, temporary resources...\n\n## Follow-up Work\nWhen to create extra tasks...\n\n## Safety Notes\nAnything cleanup should avoid...`
                  }
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
                  <div className="text-sm text-muted-foreground">
                    {agent.description?.trim() || "No description provided."}
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
