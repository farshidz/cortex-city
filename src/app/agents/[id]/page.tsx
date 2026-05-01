"use client";

import { use, useEffect, useState } from "react";
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
import type { OrchestratorConfig, PromptMode } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type PromptResponse = {
  content: string;
  path: string;
};

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

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: config, mutate: mutateConfig } =
    useSWR<OrchestratorConfig>("/api/config", fetcher);
  const { data: initialPromptData, mutate: mutateInitialPrompt } =
    useSWR<PromptResponse>(`/api/agents/${id}/prompt?mode=initial`, fetcher);
  const { data: reviewPromptData, mutate: mutateReviewPrompt } =
    useSWR<PromptResponse>(`/api/agents/${id}/prompt?mode=review`, fetcher);
  const { data: cleanupPromptData, mutate: mutateCleanupPrompt } =
    useSWR<PromptResponse>(`/api/agents/${id}/prompt?mode=cleanup`, fetcher);
  const { data: templates } = useSWR<{
    initial: string;
    review: string;
    cleanup: string;
  }>("/api/prompts", fetcher);
  const { data: envData, mutate: mutateEnv } = useSWR<{
    vars: Record<string, string>;
    path: string | null;
  }>(`/api/agents/${id}/env`, fetcher);

  const [promptContent, setPromptContent] = useState<Record<PromptMode, string>>({
    initial: "",
    review: "",
    cleanup: "",
  });
  const [promptLoaded, setPromptLoaded] = useState<Record<PromptMode, boolean>>({
    initial: false,
    review: false,
    cleanup: false,
  });
  const [savingPromptMode, setSavingPromptMode] = useState<PromptMode | null>(null);
  const [savingEnv, setSavingEnv] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [configForm, setConfigForm] = useState({
    name: "",
    repo_slug: "",
    repo_path: "",
    default_branch: "",
    git_user_name: "",
    git_user_email: "",
    description: "",
  });
  const [activeTab, setActiveTab] = useState<PromptMode>("initial");
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [envLoaded, setEnvLoaded] = useState(false);

  const agent = config?.agents[id];

  useEffect(() => {
    if (!initialPromptData || promptLoaded.initial) return;
    const handle = requestAnimationFrame(() => {
      setPromptContent((current) => ({
        ...current,
        initial: initialPromptData.content,
      }));
      setPromptLoaded((current) => ({ ...current, initial: true }));
    });
    return () => cancelAnimationFrame(handle);
  }, [initialPromptData, promptLoaded.initial]);

  useEffect(() => {
    if (!reviewPromptData || promptLoaded.review) return;
    const handle = requestAnimationFrame(() => {
      setPromptContent((current) => ({
        ...current,
        review: reviewPromptData.content,
      }));
      setPromptLoaded((current) => ({ ...current, review: true }));
    });
    return () => cancelAnimationFrame(handle);
  }, [reviewPromptData, promptLoaded.review]);

  useEffect(() => {
    if (!cleanupPromptData || promptLoaded.cleanup) return;
    const handle = requestAnimationFrame(() => {
      setPromptContent((current) => ({
        ...current,
        cleanup: cleanupPromptData.content,
      }));
      setPromptLoaded((current) => ({ ...current, cleanup: true }));
    });
    return () => cancelAnimationFrame(handle);
  }, [cleanupPromptData, promptLoaded.cleanup]);

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
  if (!agent) {
    return (
      <div className="text-muted-foreground">
        Agent &quot;{id}&quot; not found.
      </div>
    );
  }
  const currentConfig = config;
  const currentAgent = agent;

  const normalizedPrompt = (
    currentAgent.prompt_file || `.cortex/prompts/agents/${id}.md`
  ).replace(/\\/g, "/");
  const slashIndex = normalizedPrompt.lastIndexOf("/");
  const envDisplayPath = `${
    slashIndex === -1 ? "" : `${normalizedPrompt.slice(0, slashIndex)}/`
  }.env.${id}`;
  const reviewPromptPath =
    reviewPromptData?.path ||
    currentAgent.review_prompt_file ||
    `.cortex/prompts/agents/${id}.review.md`;
  const cleanupPromptPath =
    cleanupPromptData?.path ||
    currentAgent.cleanup_prompt_file ||
    `.cortex/prompts/agents/${id}.cleanup.md`;

  function startEditConfig() {
    setConfigForm({
      name: currentAgent.name,
      repo_slug: currentAgent.repo_slug,
      repo_path: currentAgent.repo_path,
      default_branch: currentAgent.default_branch,
      git_user_name: currentAgent.git_user_name || "",
      git_user_email: currentAgent.git_user_email || "",
      description: currentAgent.description || "",
    });
    setEditingConfig(true);
  }

  async function saveConfig() {
    const updated = {
      ...currentConfig,
      agents: {
        ...currentConfig.agents,
        [id]: { ...currentAgent, ...configForm },
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

  async function savePrompt(mode: PromptMode) {
    setSavingPromptMode(mode);
    await fetch(`/api/agents/${id}/prompt?mode=${mode}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: promptContent[mode] }),
    });
    if (mode === "initial") mutateInitialPrompt();
    if (mode === "review") mutateReviewPrompt();
    if (mode === "cleanup") mutateCleanupPrompt();
    setSavingPromptMode(null);
  }

  function buildPreview(mode: PromptMode): string {
    if (!templates) return "Loading...";
    const template = templates[mode];
    if (mode === "initial") {
      return template
        .replace("{{TASK_TITLE}}", "(task title)")
        .replace("{{TASK_DESCRIPTION}}", "(task description)")
        .replace("{{TASK_PLAN}}", "(task plan or 'No detailed plan provided')")
        .replace("{{AGENT_NAME}}", currentAgent.name || id)
        .replace(/\{\{BASE_BRANCH\}\}/g, currentAgent.default_branch || "main")
        .replace(
          "{{GIT_IDENTITY_SECTION}}",
          buildGitIdentityPreview(currentAgent.git_user_name, currentAgent.git_user_email)
        )
        .replace(
          "{{REPO_CONTEXT_SECTION}}",
          buildPromptSection(
            "Repository Context",
            promptContent.initial || "(your initial prompt goes here)"
          )
        )
        .replace("{{AGENT_DIRECTORY}}", "(agents list will appear here)");
    }
    if (mode === "review") {
      return template
        .replace("{{PR_URL}}", "(pr url)")
        .replace("{{AGENT_NAME}}", currentAgent.name || id)
        .replace("{{MERGE_STATUS}}", "(merge status)")
        .replace(
          "{{GIT_IDENTITY_SECTION}}",
          buildGitIdentityPreview(currentAgent.git_user_name, currentAgent.git_user_email)
        )
        .replace(/\{\{BASE_BRANCH\}\}/g, currentAgent.default_branch || "main")
        .replace(
          "{{REPO_CONTEXT_SECTION}}",
          buildPromptSection(
            "Agent Review Context",
            promptContent.review || "(optional review prompt goes here)"
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
          promptContent.cleanup || "(optional cleanup prompt goes here)"
        )
      )
      .replace("{{AGENT_DIRECTORY}}", "(agents list will appear here)");
  }

  const currentPromptData =
    activeTab === "initial"
      ? initialPromptData
      : activeTab === "review"
        ? reviewPromptData
        : cleanupPromptData;
  const currentPromptPath =
    activeTab === "initial"
      ? initialPromptData?.path || currentAgent.prompt_file
      : activeTab === "review"
        ? reviewPromptPath
        : cleanupPromptPath;
  const currentPromptLabel =
    activeTab === "initial"
      ? "initial"
      : activeTab === "review"
        ? "review"
        : "cleanup";

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{currentAgent.name}</h1>
          <Badge variant="outline">{id}</Badge>
        </div>
        <Button variant="outline" onClick={() => router.push("/agents")}>
          Back
        </Button>
      </div>

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
                <div className="space-y-1">
                  <Label className="text-xs">Git Author Name</Label>
                  <Input
                    value={configForm.git_user_name}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        git_user_name: e.target.value,
                      })
                    }
                    placeholder="Use repo or machine config"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Git Author Email</Label>
                  <Input
                    value={configForm.git_user_email}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        git_user_email: e.target.value,
                      })
                    }
                    placeholder="Use repo or machine config"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <textarea
                    className="w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm"
                    value={configForm.description}
                    onChange={(e) =>
                      setConfigForm({
                        ...configForm,
                        description: e.target.value,
                      })
                    }
                    placeholder="Short summary of this agent's responsibilities"
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
                {currentAgent.repo_slug}
              </div>
              <div>
                <span className="text-muted-foreground">Path: </span>
                <span className="font-mono text-xs">{currentAgent.repo_path}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Branch: </span>
                {currentAgent.default_branch}
              </div>
              <div>
                <span className="text-muted-foreground">Git author: </span>
                {currentAgent.git_user_name?.trim() && currentAgent.git_user_email?.trim()
                  ? `${currentAgent.git_user_name} <${currentAgent.git_user_email}>`
                  : "Repo or machine config"}
              </div>
              <div>
                <span className="text-muted-foreground">Prompt file: </span>
                <span className="font-mono text-xs">{currentAgent.prompt_file}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Review prompt: </span>
                <span className="font-mono text-xs">{reviewPromptPath}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Cleanup prompt: </span>
                <span className="font-mono text-xs">{cleanupPromptPath}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
            <code className="bg-muted px-1 rounded">{envDisplayPath}</code> and
            never committed to git. A global{" "}
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
              onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
            >
              Add Variable
            </Button>
            <Button size="sm" onClick={saveEnv} disabled={savingEnv}>
              {savingEnv ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as PromptMode)}
          >
            <TabsList>
              <TabsTrigger value="initial">Initial</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="cleanup">Cleanup</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {activeTab === "initial"
                ? "This prompt is appended to the initial task template as repository context."
                : activeTab === "review"
                  ? "This optional prompt is appended only on review runs when the orchestrator is addressing PR feedback."
                  : "This optional prompt is appended only on cleanup runs after the PR is merged or closed."}
            </p>
            <p className="text-xs text-muted-foreground">
              Stored in{" "}
              <code className="bg-muted px-1 rounded">{currentPromptPath}</code>.
            </p>
            <MdEditor
              value={promptContent[activeTab]}
              onChange={(value) =>
                setPromptContent((current) => ({ ...current, [activeTab]: value }))
              }
              rows={16}
              placeholder={
                activeTab === "initial"
                  ? `# ${currentAgent.name}\n\n## Architecture\n...\n\n## Coding Conventions\n...\n\n## Test Commands\n...\n\n## Important Notes\n...`
                  : activeTab === "review"
                    ? `# ${currentAgent.name} Review Notes\n\n## Review Priorities\n...\n\n## Common Reviewer Concerns\n...\n\n## Verification Commands\n...`
                    : `# ${currentAgent.name} Cleanup Notes\n\n## Cleanup Checklist\n...\n\n## Branch / Environment Cleanup\n...\n\n## Follow-up Work\n...`
              }
            />
            <div className="flex gap-2">
              <Button
                onClick={() => savePrompt(activeTab)}
                disabled={savingPromptMode !== null}
              >
                {savingPromptMode === activeTab
                  ? "Saving..."
                  : `Save ${currentPromptLabel} prompt`}
              </Button>
              {currentPromptData &&
                currentPromptData.content !== promptContent[activeTab] && (
                <span className="text-sm text-muted-foreground self-center">
                  Unsaved changes
                </span>
                )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Full prompt preview
            </p>
            <pre className="whitespace-pre-wrap text-sm bg-muted p-4 rounded-md overflow-auto max-h-[600px] leading-relaxed">
              {buildPreview(activeTab)}
            </pre>
            <p className="text-xs text-muted-foreground">
              The CLI also enforces a JSON schema requiring: status, summary,
              pr_url, branch_name, files_changed, assumptions, blockers,
              next_steps, and optional tool_calls.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
