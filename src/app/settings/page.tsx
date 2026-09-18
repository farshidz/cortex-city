"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentRuntime,
  ClaudeEffort,
  CodexEffort,
  OrchestratorConfig,
  PermissionMode,
  ReviewTier,
  TaskEffort,
} from "@/lib/types";
import {
  formatEffortLabel,
  getEffortOptions,
  getPermissionOptions,
} from "@/lib/runtime-config";
import {
  applyReviewerRuntime,
  applyReviewerTier,
  buildConfigUpdate,
  clearInheritedTierProfiles,
  reviewerTierConfig,
  reviewerTierRuntime,
} from "./reviewer-config";

import styles from "./settings.module.css";
import {
  ReviewerTabs,
  SETTINGS_CATEGORIES,
  type SettingsCategory,
  type ReviewerTab,
} from "./settings-navigation";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const UNSET_VALUE = "__unset__";

interface ReviewLearningsResponse {
  content: string;
  enabled: boolean;
}

export default function SettingsPage() {
  const { data: config, mutate } = useSWR<OrchestratorConfig>(
    "/api/config",
    fetcher,
  );
  const { data: learnings, mutate: mutateLearnings } =
    useSWR<ReviewLearningsResponse>("/api/reviews/learnings", fetcher);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<OrchestratorConfig | null>(null);
  const [learningsEditing, setLearningsEditing] = useState(false);
  const [learningsSaving, setLearningsSaving] = useState(false);
  const [learningsContent, setLearningsContent] = useState("");
  const [learningsError, setLearningsError] = useState("");
  const [category, setCategory] = useState<SettingsCategory>("orchestrator");
  const [reviewerTab, setReviewerTab] = useState<ReviewerTab>("general");
  const [editingTier, setEditingTier] = useState<ReviewTier | null>(null);
  const [saveError, setSaveError] = useState("");
  const [savedForm, setSavedForm] = useState<OrchestratorConfig | null>(null);
  const dirty =
    !!form &&
    JSON.stringify(buildConfigUpdate(form)) !==
      JSON.stringify(buildConfigUpdate(savedForm || config || form));
  const permissionOptions = form
    ? getPermissionOptions(form.default_agent_runner)
    : [];

  useEffect(() => {
    if (!config || form) return;
    const handle = requestAnimationFrame(() => {
      setForm(config);
      setSavedForm(config);
    });
    return () => cancelAnimationFrame(handle);
  }, [config, form]);

  useEffect(() => {
    if (!learnings || learningsEditing) return;
    const handle = requestAnimationFrame(() =>
      setLearningsContent(learnings.content),
    );
    return () => cancelAnimationFrame(handle);
  }, [learnings, learningsEditing]);

  function handleRunnerChange(value: string) {
    if (!form) return;
    if (value !== "claude" && value !== "codex") return;
    const reviewerRuntimeChanges =
      !form.review_runtime && form.default_agent_runner !== value;
    const nextPermission = getPermissionOptions(value).some(
      (option) => option.value === form.default_permission_mode,
    )
      ? form.default_permission_mode
      : (getPermissionOptions(value)[0].value as PermissionMode);
    const next: OrchestratorConfig = {
      ...form,
      default_agent_runner: value,
      default_permission_mode: nextPermission,
      ...(reviewerRuntimeChanges
        ? { review_effort: undefined, review_model: undefined }
        : {}),
    };
    // A tier that inherits its runtime inherits it from here too, so its
    // runtime-specific model and effort go with the switch.
    setForm(clearInheritedTierProfiles(next, form));
  }

  function handleReviewRunnerChange(value: string) {
    if (!form) return;
    if (value !== "claude" && value !== "codex") return;
    setForm(applyReviewerRuntime(form, value));
  }

  function renderTierControls(tier: ReviewTier, title: string, help: string) {
    if (!form) return null;
    const tierConfig = reviewerTierConfig(form, tier);
    const runtime = reviewerTierRuntime(form, tier);
    const reviewerRuntime = form.review_runtime || form.default_agent_runner;
    const inheritedModel =
      (runtime === reviewerRuntime ? form.review_model : undefined) ||
      (runtime === "codex"
        ? form.default_codex_model
        : form.default_claude_model);
    const patchTier = (patch: Parameters<typeof applyReviewerTier>[2]) =>
      setForm(applyReviewerTier(form, tier, patch));
    return (
      <div className="space-y-3 rounded-md border p-3">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">{title}</h4>
          <p className="text-xs text-muted-foreground">{help}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`tier-${tier}-runtime`}>Runtime</Label>
          <Select
            value={tierConfig.runtime || UNSET_VALUE}
            onValueChange={(v) =>
              patchTier({
                // Clearing the pin is what lets tier 1 be emptied, which is how
                // tiering is switched off.
                runtime: v === UNSET_VALUE ? null : (v as AgentRuntime),
              })
            }
          >
            <SelectTrigger id={`tier-${tier}-runtime`}>
              <SelectValue>
                {tierConfig.runtime
                  ? tierConfig.runtime === "codex"
                    ? "Codex"
                    : "Claude Code"
                  : `Reviewer default (${reviewerRuntime === "codex" ? "Codex" : "Claude Code"})`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET_VALUE}>
                Reviewer default (
                {reviewerRuntime === "codex" ? "Codex" : "Claude Code"})
              </SelectItem>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`tier-${tier}-model`}>Model</Label>
          <Input
            id={`tier-${tier}-model`}
            value={tierConfig.model ?? ""}
            placeholder={inheritedModel || "CLI default"}
            onChange={(e) => patchTier({ model: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`tier-${tier}-effort`}>Effort</Label>
          <Select
            value={tierConfig.effort || UNSET_VALUE}
            onValueChange={(v) =>
              patchTier({
                effort: v === UNSET_VALUE ? undefined : (v as TaskEffort),
              })
            }
          >
            <SelectTrigger id={`tier-${tier}-effort`}>
              <SelectValue>
                {tierConfig.effort
                  ? formatEffortLabel(tierConfig.effort)
                  : "Reviewer default"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET_VALUE}>Reviewer default</SelectItem>
              {getEffortOptions(runtime).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  async function saveConfig() {
    if (!form) return;
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildConfigUpdate(form)),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error || `Could not save settings (${response.status}).`,
        );
      }
      // The API returns normalized settings, including cleared optional values.
      const updated: OrchestratorConfig = await response.json();
      setForm(updated);
      setSavedForm(updated);
      await mutate(updated, { revalidate: false });
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveLearnings() {
    setLearningsSaving(true);
    setLearningsError("");
    try {
      const response = await fetch("/api/reviews/learnings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: learningsContent }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.error || `Could not save review learnings (${response.status}).`,
        );
      }
      await mutateLearnings();
      setLearningsEditing(false);
    } catch (error) {
      setLearningsError(
        error instanceof Error
          ? error.message
          : "Could not save review learnings.",
      );
    } finally {
      setLearningsSaving(false);
    }
  }

  function toggleLearningsEditing() {
    setLearningsError("");
    if (learningsEditing) {
      setLearningsContent(learnings?.content ?? "");
      setLearningsEditing(false);
      return;
    }
    if (!learnings) return;
    setLearningsContent(learnings.content);
    setLearningsEditing(true);
  }

  if (!form) return <div className="text-muted-foreground">Loading...</div>;

  return (
    <div className={styles.settings}>
      <header className={styles.header}>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Configure how your agents run and review.
          </p>
        </div>
        <div className={styles.actions}>
          <span role="status" className="text-xs text-muted-foreground">
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : "All changes saved"}
          </span>
          <Button onClick={saveConfig} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
        {saveError && (
          <p role="alert" className={styles.saveError}>
            {saveError}
          </p>
        )}
      </header>
      <div className={styles.workspace}>
        <nav aria-label="Settings categories" className={styles.categories}>
          <p className={styles.eyebrow}>Configuration</p>
          {SETTINGS_CATEGORIES.map(({ id, title, description }) => (
            <button
              key={id}
              type="button"
              aria-current={category === id ? "page" : undefined}
              aria-controls={`settings-${id}`}
              onClick={() => setCategory(id)}
            >
              <span>{title}</span>
              <small>{description}</small>
            </button>
          ))}
        </nav>
        <fieldset
          disabled={saving}
          className={styles.content}
          aria-label="Settings"
        >
          <div
            id="settings-orchestrator"
            hidden={category !== "orchestrator"}
            className={styles.panel}
          >
            <h2>Orchestrator</h2>
            <p className={styles.description}>
              Set session capacity and scheduling.
            </p>
            <div className={styles.field}>
              <Label htmlFor="orchestrator-0">Max Parallel Sessions</Label>
              <Input
                id="orchestrator-0"
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
            <div className={styles.field}>
              <Label htmlFor="orchestrator-1">Poll Interval (seconds)</Label>
              <Input
                id="orchestrator-1"
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
          </div>
          <div
            id="settings-agents"
            hidden={category !== "agents"}
            className={styles.panel}
          >
            <h2>Agent defaults</h2>
            <p className={styles.description}>
              Default runtime, permissions, and model profiles for tasks.
            </p>
            <div className={styles.field}>
              <Label htmlFor="agent-0">Default Agent Runtime</Label>
              <Select
                value={form.default_agent_runner}
                onValueChange={(v) => v && handleRunnerChange(v)}
              >
                <SelectTrigger id="agent-0">
                  <SelectValue>
                    {form.default_agent_runner === "codex"
                      ? "Codex"
                      : "Claude Code"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={styles.field}>
              <Label htmlFor="agent-1">Default Permission Mode</Label>
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
                <SelectTrigger id="agent-1">
                  <SelectValue>
                    {permissionOptions.find(
                      (option) => option.value === form.default_permission_mode,
                    )?.label || form.default_permission_mode}
                  </SelectValue>
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
            <h3 className={styles.subheading}>Claude Defaults</h3>
            <div className={styles.field}>
              <Label htmlFor="claude-0">Default Claude Model</Label>
              <Input
                id="claude-0"
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
            <div className={styles.field}>
              <Label htmlFor="claude-1">Default Claude Effort</Label>
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
                <SelectTrigger id="claude-1">
                  <SelectValue>
                    {formatEffortLabel(form.default_claude_effort)}
                  </SelectValue>
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
            <h3 className={styles.subheading}>Codex Defaults</h3>
            <div className={styles.field}>
              <Label htmlFor="codex-0">Default Codex Model</Label>
              <Input
                id="codex-0"
                value={form.default_codex_model || ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    default_codex_model: e.target.value || undefined,
                  })
                }
                placeholder="gpt-5.6"
              />
            </div>
            <div className={styles.field}>
              <Label htmlFor="codex-1">Default Codex Effort</Label>
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
                <SelectTrigger id="codex-1">
                  <SelectValue>
                    {formatEffortLabel(form.default_codex_effort)}
                  </SelectValue>
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
          </div>
          <div
            id="settings-reviewer"
            hidden={category !== "reviewer"}
            className={styles.panel}
          >
            <h2>Reviewer</h2>
            <p className={styles.description}>
              Configure review behavior, instructions, and collected knowledge.
            </p>
            <ReviewerTabs active={reviewerTab} onChange={setReviewerTab} />
            <div
              role="tabpanel"
              id="reviewer-general"
              aria-labelledby="tab-general"
              hidden={reviewerTab !== "general"}
            >
              <div className={styles.field}>
                <Label htmlFor="reviewer-1">Default Reviewer Runtime</Label>
                <Select
                  value={form.review_runtime || form.default_agent_runner}
                  onValueChange={(v) => v && handleReviewRunnerChange(v)}
                >
                  <SelectTrigger id="reviewer-1">
                    <SelectValue>
                      {(form.review_runtime || form.default_agent_runner) ===
                      "codex"
                        ? "Codex"
                        : "Claude Code"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude Code</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className={styles.field}>
                <Label htmlFor="reviewer-2">Default Reviewer Model</Label>
                <Input
                  id="reviewer-2"
                  value={form.review_model ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      review_model: e.target.value,
                    })
                  }
                  placeholder={
                    (form.review_runtime || form.default_agent_runner) ===
                    "codex"
                      ? form.default_codex_model || "gpt-5.6"
                      : form.default_claude_model || "claude-sonnet-4-6"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Enter any model supported by the selected runtime. Leave blank
                  to use that runtime&apos;s default model.
                </p>
              </div>
              <div className={styles.field}>
                <Label htmlFor="reviewer-3">Default Reviewer Effort</Label>
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
                  <SelectTrigger id="reviewer-3">
                    <SelectValue>
                      {formatEffortLabel(form.review_effort)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNSET_VALUE}>CLI default</SelectItem>
                    {getEffortOptions(
                      form.review_runtime || form.default_agent_runner,
                    ).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={styles.field}>
                <Label htmlFor="reviewer-4">Max Parallel Review Runs</Label>
                <Input
                  id="reviewer-4"
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
              <div className={styles.field}>
                <Label htmlFor="reviewer-7">Review Debounce (seconds)</Label>
                <Input
                  id="reviewer-7"
                  type="number"
                  min={0}
                  max={3600}
                  value={form.review_debounce_seconds ?? 300}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      review_debounce_seconds: Math.max(
                        0,
                        parseInt(e.target.value) || 0,
                      ),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  How long a pull request head must sit still before a changed
                  diff starts a review round. Pull requests in the same stack
                  share the window. 0 reviews immediately.
                </p>
              </div>
              <div className={styles.subheading}>
                <h3>Reviewer tiers</h3>
                <span className={styles.badge}>Optional overrides</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Verification checks fixes; the review tier owns the final
                verdict. Leave all verification overrides empty to run every
                round on the review tier.
              </p>
              <div className={styles.tableScroll}>
                <table className={styles.tiers}>
                  <thead>
                    <tr>
                      <th>Tier</th>
                      <th>Runtime</th>
                      <th>Model / effort</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {([1, 2] as const).map((tier) => {
                      const profile = reviewerTierConfig(form, tier);
                      const runtime = reviewerTierRuntime(form, tier);
                      const inheritedRuntime =
                        form.review_runtime || form.default_agent_runner;
                      const model =
                        profile.model ||
                        (runtime === inheritedRuntime
                          ? form.review_model
                          : undefined) ||
                        (runtime === "codex"
                          ? form.default_codex_model
                          : form.default_claude_model) ||
                        "CLI default";
                      const effort =
                        profile.effort ||
                        (runtime === inheritedRuntime
                          ? form.review_effort
                          : undefined) ||
                        (runtime === "codex"
                          ? form.default_codex_effort
                          : form.default_claude_effort);
                      return (
                        <tr key={tier}>
                          <td>
                            <strong>
                              {tier === 1
                                ? "Verification tier (tier 1)"
                                : "Review tier (tier 2)"}
                            </strong>
                            <small>
                              {tier === 1
                                ? "Follow-up checks"
                                : "Full review & final verdict"}
                            </small>
                          </td>
                          <td>
                            {profile.runtime
                              ? runtime === "codex"
                                ? "Codex"
                                : "Claude Code"
                              : "Reviewer default"}
                          </td>
                          <td>
                            {tier === 1 &&
                            !profile.runtime &&
                            !profile.model &&
                            !profile.effort ? (
                              <>
                                No overrides
                                <small>All rounds use review tier</small>
                              </>
                            ) : (
                              <>
                                {model}
                                <small>
                                  {formatEffortLabel(effort)}
                                  {!profile.model && !profile.effort
                                    ? " · Inherited"
                                    : ""}
                                </small>
                              </>
                            )}
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={editingTier === tier}
                              aria-controls={`tier-editor-${tier}`}
                              onClick={() =>
                                setEditingTier(
                                  editingTier === tier ? null : tier,
                                )
                              }
                            >
                              {editingTier === tier ? "Close" : "Configure"}
                              <span className="sr-only">
                                {" "}
                                {tier === 1 ? "verification" : "review"} tier
                              </span>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {([1, 2] as const).map((tier) => (
                <div
                  key={tier}
                  id={`tier-editor-${tier}`}
                  hidden={editingTier !== tier}
                >
                  {renderTierControls(
                    tier,
                    tier === 1
                      ? "Verification tier overrides"
                      : "Review tier overrides",
                    "Leave fields empty to inherit reviewer defaults.",
                  )}
                </div>
              ))}
              <details className={styles.disclosure}>
                <summary>
                  Usage limits & exempt authors
                  <span>
                    {form.review_weekly_usage_limit_percent == null
                      ? "No weekly limit"
                      : `${form.review_weekly_usage_limit_percent}% weekly limit`}
                  </span>
                </summary>
                <div className="px-4 pb-4">
                  <div className={styles.field}>
                    <Label htmlFor="review-weekly-limit">
                      Weekly Codex Usage Limit (%)
                    </Label>
                    <Input
                      id="review-weekly-limit"
                      type="number"
                      min={0}
                      max={100}
                      value={form.review_weekly_usage_limit_percent ?? ""}
                      placeholder="No limit"
                      onChange={(e) =>
                        setForm({
                          ...form,
                          review_weekly_usage_limit_percent:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Refuse reviews for non-exempt authors when weekly usage
                      reaches this percentage. Leave empty to disable the limit
                      for everyone.
                    </p>
                  </div>
                  <div className={styles.field}>
                    <Label htmlFor="review-author-whitelist">
                      Authors Exempt from Usage Limit
                    </Label>
                    <Input
                      id="review-author-whitelist"
                      value={(form.review_author_whitelist ?? []).join(", ")}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          review_author_whitelist: e.target.value
                            .split(",")
                            .map((login) => login.trimStart()),
                        })
                      }
                      placeholder="octocat, another-author"
                    />
                    <p className="text-xs text-muted-foreground">
                      These GitHub authors can be reviewed regardless of weekly
                      Codex usage. Leave empty to apply the configured limit to
                      everyone.
                    </p>
                  </div>
                </div>
              </details>
            </div>
            <div
              role="tabpanel"
              id="reviewer-prompts"
              aria-labelledby="tab-prompts"
              hidden={reviewerTab !== "prompts"}
              className={styles.prompts}
            >
              <div className={styles.field}>
                <Label htmlFor="review-prompt">Reviewer Prompt</Label>
                <Textarea
                  id="review-prompt"
                  rows={8}
                  value={form.review_prompt ?? ""}
                  placeholder="Default reviewer prompt will be used if left blank."
                  onChange={(e) =>
                    setForm({
                      ...form,
                      review_prompt: e.target.value || undefined,
                    })
                  }
                />
              </div>
              <div className={styles.field}>
                <Label htmlFor="task-review-prompt">
                  Task-owned review instructions (optional)
                </Label>
                <Textarea
                  id="task-review-prompt"
                  rows={6}
                  value={form.reviewer_agent_prompt ?? ""}
                  placeholder="Optional instructions applied when reviewing your task-owned pull requests."
                  onChange={(e) =>
                    setForm({
                      ...form,
                      reviewer_agent_prompt: e.target.value || undefined,
                    })
                  }
                />
              </div>
              <p className={styles.footnote}>
                Prompts are saved with your other settings using Save changes.
              </p>
            </div>
            <div
              role="tabpanel"
              id="reviewer-learnings"
              aria-labelledby="tab-learnings"
              hidden={reviewerTab !== "learnings"}
            >
              <div className="flex items-center gap-2">
                <Switch
                  id="review-learning-enabled"
                  checked={form.review_learning_enabled !== false}
                  onCheckedChange={(checked) =>
                    setForm({
                      ...form,
                      review_learning_enabled: checked,
                    })
                  }
                />
                <Label htmlFor="review-learning-enabled">
                  Learning enabled
                </Label>
              </div>
              <section className={styles.learnings}>
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-base">Review learnings</h3>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={toggleLearningsEditing}
                      disabled={
                        learningsSaving || (!learnings && !learningsEditing)
                      }
                    >
                      {learningsEditing ? "Cancel" : "Edit"}
                    </Button>
                  </div>
                </div>
                <div className="space-y-3">
                  {learningsEditing ? (
                    <>
                      <Textarea
                        aria-label="Review learnings"
                        rows={10}
                        value={learningsContent}
                        onChange={(e) => setLearningsContent(e.target.value)}
                        disabled={learningsSaving}
                      />
                      {learningsError && (
                        <p role="alert" className="text-sm text-destructive">
                          {learningsError}
                        </p>
                      )}
                      <Button
                        type="button"
                        onClick={saveLearnings}
                        disabled={learningsSaving}
                      >
                        {learningsSaving ? "Saving..." : "Save learnings"}
                      </Button>
                    </>
                  ) : (
                    <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                      {learnings?.content?.trim() ||
                        "No review learnings recorded yet."}
                    </pre>
                  )}
                </div>
              </section>
              <p className={styles.footnote}>
                Learning content is saved separately. The learning toggle is
                saved with your other settings.
              </p>
            </div>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
