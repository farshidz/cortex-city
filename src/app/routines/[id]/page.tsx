"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Routine } from "@/lib/types";
import {
  AgentFields,
  agentPayload,
  apiRequest,
  EnabledPill,
  errorMessage,
  fetcher,
  optionalInteger,
  ScheduleFields,
  type AgentFormValue,
  type RoutineDetail,
} from "../routine-ui";
import { RunsTable, SecretsCard, SlackCard, StorageCard } from "./routine-cards";

interface RoutineForm {
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  agent: AgentFormValue;
  global_secrets: string[];
  allowed_channels: string[];
  failure_channel: string;
  keep_runs: string;
  max_run_mb: string;
}

function formFromRoutine(routine: Routine): RoutineForm {
  return {
    name: routine.name,
    prompt: routine.prompt,
    cron: routine.cron,
    timezone: routine.timezone,
    agent: {
      agent_runner: routine.agent_runner ?? "",
      model: routine.model ?? "",
      effort: routine.effort ?? "",
      timeout_minutes: routine.timeout_minutes ? String(routine.timeout_minutes) : "",
    },
    global_secrets: routine.global_secrets ?? [],
    allowed_channels: routine.slack?.allowed_channels ?? [],
    failure_channel: routine.slack?.failure_channel ?? "",
    keep_runs: routine.keep_runs ? String(routine.keep_runs) : "",
    max_run_mb: routine.max_run_mb ? String(routine.max_run_mb) : "",
  };
}

function payloadFromForm(form: RoutineForm) {
  return {
    name: form.name,
    prompt: form.prompt,
    cron: form.cron,
    timezone: form.timezone,
    ...agentPayload(form.agent),
    global_secrets: form.global_secrets,
    slack: {
      allowed_channels: form.allowed_channels,
      failure_channel: form.failure_channel.trim() || undefined,
    },
    keep_runs: optionalInteger(form.keep_runs),
    max_run_mb: optionalInteger(form.max_run_mb),
  };
}

type Notice = { tone: "info" | "error"; text: string } | null;

export default function RoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error, mutate } = useSWR<RoutineDetail>(`/api/routines/${id}`, fetcher, {
    refreshInterval: 5000,
  });
  // Null until the first edit: the form follows the server until then.
  const [draft, setDraft] = useState<RoutineForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const detail = data && "routine" in data ? data : undefined;
  if (error || (data && !detail)) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-destructive">
          {(data as { error?: string } | undefined)?.error ?? "Couldn't load this routine."}
        </p>
        <Link href="/routines" className="text-sm underline">
          Back to Routines
        </Link>
      </div>
    );
  }
  if (!detail) return <div className="text-muted-foreground">Loading…</div>;

  const { routine, runs, secrets } = detail;
  const saved = formFromRoutine(routine);
  const form = draft ?? saved;
  const dirty = JSON.stringify(payloadFromForm(form)) !== JSON.stringify(payloadFromForm(saved));

  function update(patch: Partial<RoutineForm>) {
    setDraft({ ...form, ...patch });
    setNotice(null);
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const updated = await apiRequest<RoutineDetail>(
        `/api/routines/${id}`,
        "PUT",
        payloadFromForm(form),
      );
      await mutate(updated, { revalidate: false });
      setDraft(null);
      setNotice({ tone: "info", text: "Saved." });
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err, "Couldn't save the routine.") });
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await apiRequest<RoutineDetail>(`/api/routines/${id}`, "PUT", { enabled });
      await mutate(updated, { revalidate: false });
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err, "Couldn't update the routine.") });
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiRequest<{ worker_notified?: boolean }>(
        `/api/routines/${id}/run`,
        "POST",
      );
      setNotice({
        tone: "info",
        text: `Run requested.${result.worker_notified === false ? " It starts on the worker's next poll." : ""}`,
      });
      await mutate();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err, "Couldn't start the run.") });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete “${routine.name}” and all of its runs and files? This can't be undone.`)) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await apiRequest(`/api/routines/${id}`, "DELETE");
      router.push("/routines");
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err, "Couldn't delete the routine.") });
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/routines" className="hover:underline">
          Routines
        </Link>{" "}
        / <span aria-current="page">{routine.name}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold break-words">{routine.name}</h1>
          <EnabledPill enabled={routine.enabled} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setEnabled(!routine.enabled)}
          >
            {routine.enabled ? "Pause" : "Resume"}
          </Button>
          <Button variant="outline" disabled={saving || !dirty} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button disabled={busy || Boolean(routine.run_requested_at)} onClick={runNow}>
            {routine.run_requested_at ? "Run requested" : "Run now"}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            Delete
          </Button>
        </div>
      </div>

      <div aria-live="polite" className="min-h-5 text-sm">
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : undefined}
            className={notice.tone === "error" ? "text-destructive" : "text-muted-foreground"}
          >
            {notice.text}
          </p>
        ) : dirty ? (
          <p className="text-muted-foreground">Unsaved changes</p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Prompt</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="routine-name">Name</Label>
                <Input
                  id="routine-name"
                  value={form.name}
                  maxLength={200}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="routine-prompt">Prompt</Label>
                <Textarea
                  id="routine-prompt"
                  rows={12}
                  value={form.prompt}
                  onChange={(e) => update({ prompt: e.target.value })}
                  aria-describedby="routine-prompt-help"
                />
                <p id="routine-prompt-help" className="text-xs text-muted-foreground">
                  The whole job, in plain text. Cortex City adds where to save files
                  and how to report back.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Schedule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScheduleFields
                idPrefix="routine-schedule"
                cron={form.cron}
                timezone={form.timezone}
                onCronChange={(cron) => update({ cron })}
                onTimezoneChange={(timezone) => update({ timezone })}
                paused={!routine.enabled}
              />
              <p className="text-xs text-muted-foreground">
                If the last run is still going, the next one is skipped. Runs missed
                while the worker was down run once when it restarts.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agent</CardTitle>
            </CardHeader>
            <CardContent>
              <AgentFields
                idPrefix="routine-agent"
                value={form.agent}
                onChange={(agent) => update({ agent })}
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <SecretsCard
            routineId={id}
            routineSecrets={secrets}
            selected={form.global_secrets}
            onSelectedChange={(global_secrets) => update({ global_secrets })}
            onSecretsChanged={() => mutate()}
          />
          <SlackCard
            channels={form.allowed_channels}
            failureChannel={form.failure_channel}
            onChange={({ channels, failureChannel }) =>
              update({
                ...(channels ? { allowed_channels: channels } : {}),
                ...(failureChannel !== undefined ? { failure_channel: failureChannel } : {}),
              })
            }
          />
          <StorageCard
            storageBytes={routine.storage_bytes}
            keepRuns={form.keep_runs}
            maxRunMb={form.max_run_mb}
            onChange={({ keepRuns, maxRunMb }) =>
              update({
                ...(keepRuns !== undefined ? { keep_runs: keepRuns } : {}),
                ...(maxRunMb !== undefined ? { max_run_mb: maxRunMb } : {}),
              })
            }
          />
        </div>
      </div>

      <section aria-labelledby="routine-runs-heading" className="space-y-2 pt-2">
        <h2 id="routine-runs-heading" className="text-lg font-semibold">
          Runs
        </h2>
        <RunsTable routineId={id} runs={runs} />
      </section>
    </div>
  );
}
