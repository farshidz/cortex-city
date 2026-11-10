"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SECRET_KIND_LABELS, SecretForm, type SecretFormValues } from "@/components/secret-form";
import type { RoutineRun, SecretMetadata } from "@/lib/types";
import {
  AMBER_BADGE,
  apiRequest,
  channelLabel,
  DEFAULT_KEEP_RUNS,
  DEFAULT_MAX_RUN_MB,
  errorMessage,
  fetcher,
  formatBytes,
  formatDateTime,
  formatDuration,
  Pill,
  RunStatusPill,
  type GlobalSecret,
} from "../routine-ui";

// --- Secrets ---

export function SecretsCard({
  routineId,
  routineSecrets,
  selected,
  onSelectedChange,
  onSecretsChanged,
}: {
  routineId: string;
  routineSecrets: SecretMetadata[];
  selected: string[];
  onSelectedChange: (names: string[]) => void;
  onSecretsChanged: () => Promise<unknown>;
}) {
  const { data: globalData } = useSWR<GlobalSecret[]>("/api/secrets", fetcher);
  const globals = Array.isArray(globalData) ? globalData : undefined;
  const globalNames = new Set(globals?.map((secret) => secret.name));
  const missing = selected.filter((name) => globals && !globalNames.has(name));
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [error, setError] = useState("");

  function toggle(name: string, checked: boolean) {
    onSelectedChange(
      checked ? [...selected, name] : selected.filter((entry) => entry !== name),
    );
  }

  async function save(values: SecretFormValues) {
    await apiRequest(`/api/routines/${routineId}/secrets`, "PUT", values);
    await onSecretsChanged();
    setAdding(false);
    setReplacing(null);
  }

  async function remove(name: string) {
    if (!confirm(`Delete the routine secret ${name}? Runs after this won't get it.`)) return;
    setError("");
    try {
      await apiRequest(
        `/api/routines/${routineId}/secrets?name=${encodeURIComponent(name)}`,
        "DELETE",
      );
      await onSecretsChanged();
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete the secret."));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Global secrets this routine can use</legend>
          {!globals ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : globals.length === 0 && missing.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No global secrets yet. Add them in{" "}
              <Link href="/settings" className="underline">
                Settings → Secrets
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-2">
              {globals.map((secret) => (
                <li key={secret.name}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-primary"
                      checked={selected.includes(secret.name)}
                      onChange={(e) => toggle(secret.name, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="font-mono text-xs">{secret.name}</span>
                      {secret.description && (
                        <span className="block text-xs text-muted-foreground">
                          {secret.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
              {missing.map((name) => (
                <li key={name}>
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-primary"
                      checked
                      onChange={(e) => toggle(name, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="font-mono text-xs">{name}</span>
                      <span className="block text-xs text-destructive">
                        No longer exists in Settings. Untick to remove.
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">This routine only</h3>
          {routineSecrets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routine secrets.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {routineSecrets.map((secret) => (
                <li key={secret.name} className="space-y-2 p-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs">{secret.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {SECRET_KIND_LABELS[secret.kind]}
                        </span>
                        {globalNames.has(secret.name) && (
                          <Pill className={AMBER_BADGE}>Overrides global</Pill>
                        )}
                      </div>
                      {secret.description && (
                        <p className="text-xs text-muted-foreground">{secret.description}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        aria-expanded={replacing === secret.name}
                        onClick={() =>
                          setReplacing(replacing === secret.name ? null : secret.name)
                        }
                      >
                        Replace<span className="sr-only"> {secret.name}</span>
                      </Button>
                      <Button size="xs" variant="destructive" onClick={() => remove(secret.name)}>
                        Delete<span className="sr-only"> {secret.name}</span>
                      </Button>
                    </div>
                  </div>
                  {replacing === secret.name && (
                    <SecretForm
                      idPrefix={`routine-secret-replace-${secret.name}`}
                      existing={secret}
                      submitLabel="Save secret"
                      onSave={save}
                      onCancel={() => setReplacing(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {adding ? (
            <SecretForm
              idPrefix="routine-secret-new"
              submitLabel="Add routine secret"
              onSave={save}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              Add routine secret
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Values can&apos;t be viewed after saving. The agent sees names and
          descriptions, values only as environment variables.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Slack ---

export function SlackCard({
  channels,
  failureChannel,
  onChange,
}: {
  channels: string[];
  failureChannel: string;
  onChange: (next: { channels?: string[]; failureChannel?: string }) => void;
}) {
  const { data: slack } = useSWR<{ connected: boolean }>("/api/integrations/slack", fetcher);
  const [draft, setDraft] = useState("");

  function addChannel() {
    const names = draft
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    onChange({ channels: [...new Set([...channels, ...names])] });
    setDraft("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {slack && slack.connected === false && (
          <p className="text-sm text-muted-foreground">
            Slack isn&apos;t connected, so nothing will be posted. Connect it in{" "}
            <Link href="/settings" className="underline">
              Settings → Integrations
            </Link>
            .
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="routine-slack-add">
            Channels this routine may ask Cortex City to post to
          </Label>
          {channels.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Allowed channels">
              {channels.map((channel) => (
                <li
                  key={channel}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs"
                >
                  <span className="font-mono">{channelLabel(channel)}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`Remove ${channel}`}
                    onClick={() => onChange({ channels: channels.filter((entry) => entry !== channel) })}
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              None. Requests to post anywhere are refused.
            </p>
          )}
          <div className="flex gap-2">
            <Input
              id="routine-slack-add"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChannel();
                }
              }}
              placeholder="#team-reports"
              spellCheck={false}
              autoComplete="off"
            />
            <Button type="button" variant="outline" onClick={addChannel} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="routine-slack-failure">Failure notices</Label>
          <Input
            id="routine-slack-failure"
            value={failureChannel}
            onChange={(e) => onChange({ failureChannel: e.target.value })}
            placeholder="#alerts"
            spellCheck={false}
            autoComplete="off"
            aria-describedby="routine-slack-failure-help"
          />
          <p id="routine-slack-failure-help" className="text-xs text-muted-foreground">
            Cortex City posts here when a run fails or times out.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Storage ---

export function StorageCard({
  storageBytes,
  keepRuns,
  maxRunMb,
  onChange,
}: {
  storageBytes: number;
  keepRuns: string;
  maxRunMb: string;
  onChange: (next: { keepRuns?: string; maxRunMb?: string }) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          <span className="text-muted-foreground">Used:</span> {formatBytes(storageBytes)}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="routine-keep-runs">Keep last N runs</Label>
            <Input
              id="routine-keep-runs"
              type="number"
              min={1}
              max={1000}
              inputMode="numeric"
              value={keepRuns}
              placeholder={String(DEFAULT_KEEP_RUNS)}
              onChange={(e) => onChange({ keepRuns: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="routine-max-run-mb">Max per run (MB)</Label>
            <Input
              id="routine-max-run-mb"
              type="number"
              min={1}
              max={10000}
              inputMode="numeric"
              value={maxRunMb}
              placeholder={String(DEFAULT_MAX_RUN_MB)}
              onChange={(e) => onChange({ maxRunMb: e.target.value })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Older runs&apos; files and transcripts are deleted automatically. Kept runs
          are never deleted.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Runs ---

function slackSummary(run: RoutineRun): string {
  const counts = new Map<string, number>();
  for (const message of run.slack_messages ?? []) {
    counts.set(message.status, (counts.get(message.status) ?? 0) + 1);
  }
  if (counts.size === 0) return "—";
  const order: [string, string][] = [
    ["sent", "sent"],
    ["failed", "failed"],
    ["refused", "refused"],
    ["pending", "pending"],
  ];
  return order
    .filter(([status]) => counts.has(status))
    .map(([status, label]) => `${counts.get(status)} ${label}`)
    .join(", ");
}

export function RunsTable({ routineId, runs }: { routineId: string; runs: RoutineRun[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Files</TableHead>
          <TableHead>Slack</TableHead>
          <TableHead>
            <span className="sr-only">Kept</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              <Link
                href={`/routines/${routineId}/runs/${run.id}`}
                className="font-medium hover:underline"
              >
                #{run.number}
              </Link>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatDateTime(run.started_at ?? run.scheduled_for ?? run.created_at)}
            </TableCell>
            <TableCell className="text-sm">
              {run.trigger === "manual" ? "Manual" : "Scheduled"}
            </TableCell>
            <TableCell className="text-sm">
              {formatDuration(run.started_at, run.finished_at)}
            </TableCell>
            <TableCell>
              <RunStatusPill status={run.status} />
            </TableCell>
            <TableCell className="text-sm">{run.artifacts?.length ?? 0}</TableCell>
            <TableCell className="text-sm">{slackSummary(run)}</TableCell>
            <TableCell>
              {run.kept && (
                <Pill className="border border-border text-foreground">Kept</Pill>
              )}
            </TableCell>
          </TableRow>
        ))}
        {runs.length === 0 && (
          <TableRow>
            <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
              No runs yet. Click Run now to try it.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
