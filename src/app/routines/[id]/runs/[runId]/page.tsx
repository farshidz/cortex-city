"use client";

import { use, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatEffortLabel } from "@/lib/runtime-config";
import type { RoutineArtifact, RoutineRun, RoutineSlackMessage } from "@/lib/types";
import {
  apiRequest,
  artifactUrl,
  channelLabel,
  errorMessage,
  fetcher,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatTokens,
  isActiveRun,
  Pill,
  RunStatusPill,
  runtimeLabel,
} from "../../../routine-ui";

interface RunResponse {
  run: RoutineRun;
  routine: { id: string; name: string };
}

function agentLabel(run: RoutineRun): string {
  const parts = [runtimeLabel(run.runtime)];
  const detail = [run.effort ? formatEffortLabel(run.effort) : null, run.model]
    .filter(Boolean)
    .join(" / ");
  if (detail) parts.push(detail);
  return parts.join(" · ");
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

function SlackStatus({ message }: { message: RoutineSlackMessage }) {
  switch (message.status) {
    case "sent":
      return (
        <span className="text-green-700 dark:text-green-400">
          Sent{message.sent_at ? ` ${formatDateTime(message.sent_at)}` : ""}
        </span>
      );
    case "refused":
      return <span className="text-muted-foreground">Refused</span>;
    case "failed":
      return (
        <span className="text-red-700 dark:text-red-400">
          Failed{message.error ? `: ${message.error}` : ""}
        </span>
      );
    default:
      return <span className="text-muted-foreground">Pending</span>;
  }
}

function ArtifactPreview({ url, artifact }: { url: string; artifact: RoutineArtifact }) {
  if (artifact.content_type.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- untrusted run file served by the API
      <img
        src={url}
        alt={artifact.title}
        className="max-h-[640px] max-w-full rounded-lg border object-contain"
      />
    );
  }
  return (
    <iframe
      title={artifact.title}
      src={url}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="h-[640px] w-full rounded-lg border bg-white"
    />
  );
}

export default function RoutineRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = use(params);
  const base = `/api/routines/${id}/runs/${runId}`;
  const { data, error, mutate } = useSWR<RunResponse>(base, fetcher, {
    refreshInterval: (latest) => (latest && "run" in latest && isActiveRun(latest.run.status) ? 3000 : 0),
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const loaded = data && "run" in data ? data : undefined;
  if (error || (data && !loaded)) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-destructive">
          {(data as { error?: string } | undefined)?.error ?? "Couldn't load this run."}
        </p>
        <Link href={`/routines/${id}`} className="text-sm underline">
          Back to the routine
        </Link>
      </div>
    );
  }
  if (!loaded) return <div className="text-muted-foreground">Loading…</div>;

  const { run, routine } = loaded;
  const artifacts = run.artifacts ?? [];
  const main = artifacts.find((artifact) => artifact.main);
  const slackMessages = run.slack_messages ?? [];
  const secretsUsed = run.secrets_used ?? [];

  async function act(action: () => Promise<unknown>, fallback: string, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice({ tone: "info", text: success });
      await mutate();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err, fallback) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/routines" className="hover:underline">
          Routines
        </Link>{" "}
        /{" "}
        <Link href={`/routines/${routine.id}`} className="hover:underline">
          {routine.name}
        </Link>{" "}
        / <span aria-current="page">Run #{run.number}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">
            {routine.name} · Run #{run.number}
          </h1>
          <RunStatusPill status={run.status} />
          {run.stop_requested && isActiveRun(run.status) && (
            <span className="text-sm text-muted-foreground">Stopping…</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            aria-pressed={Boolean(run.kept)}
            disabled={busy}
            onClick={() =>
              act(
                () => apiRequest(base, "PATCH", { kept: !run.kept }),
                "Couldn't update the run.",
              )
            }
          >
            {run.kept ? "Kept" : "Keep this run"}
          </Button>
          {run.status === "running" && (
            <Button
              variant="destructive"
              disabled={busy || run.stop_requested}
              onClick={() =>
                act(
                  () => apiRequest(base, "PATCH", { action: "stop" }),
                  "Couldn't stop the run.",
                  "Stop requested.",
                )
              }
            >
              Stop
            </Button>
          )}
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={`${base}/transcript`} target="_blank" rel="noopener noreferrer" />}
          >
            View transcript
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              act(
                () => apiRequest(`/api/routines/${routine.id}/run`, "POST"),
                "Couldn't start a run.",
                "Run requested. It will appear on the routine's page.",
              )
            }
          >
            Run again
          </Button>
        </div>
      </div>

      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {notice.text}
        </p>
      )}

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Trigger">{run.trigger === "manual" ? "Manual" : "Scheduled"}</Fact>
            <Fact label="Started">{formatDateTime(run.started_at ?? run.created_at)}</Fact>
            <Fact label="Duration">{formatDuration(run.started_at, run.finished_at)}</Fact>
            <Fact label="Agent">{agentLabel(run)}</Fact>
            <Fact label="Tokens (in / out)">
              {formatTokens(run.input_tokens)} / {formatTokens(run.output_tokens)}
            </Fact>
            <Fact label="Files">
              {artifacts.length} · {formatBytes(run.artifacts_bytes)}
            </Fact>
          </dl>
        </CardContent>
      </Card>

      {run.error && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
        >
          <p className="font-medium">Error</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{run.error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Summary from the agent</CardTitle>
        </CardHeader>
        <CardContent>
          {run.report?.summary ? (
            <p className="text-sm whitespace-pre-wrap">{run.report.summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {isActiveRun(run.status) ? "The run hasn't reported yet." : "No summary was reported."}
            </p>
          )}
        </CardContent>
      </Card>

      {main && (
        <section aria-labelledby="main-report-heading" className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h2 id="main-report-heading" className="text-lg font-semibold">
                {main.title}
              </h2>
              <p className="text-xs text-muted-foreground break-all">
                <span className="font-mono">{main.path}</span> · {formatBytes(main.size)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <a href={artifactUrl(id, runId, main.path)} target="_blank" rel="noopener noreferrer" />
                }
              >
                Open full screen
              </Button>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={artifactUrl(id, runId, main.path, true)} />}
              >
                Download
              </Button>
            </div>
          </div>
          <ArtifactPreview url={artifactUrl(id, runId, main.path)} artifact={main} />
          <p className="text-xs text-muted-foreground">
            Shown in a sandboxed frame. Scripts in the report run but can&apos;t reach
            Cortex City.
          </p>
        </section>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>All files</CardTitle>
          {artifacts.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={`${base}/download`} />}
            >
              Download all (.zip)
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">This run saved no files.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {artifacts.map((artifact) => (
                <li
                  key={artifact.path}
                  className="flex flex-wrap items-center justify-between gap-2 p-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">
                      {artifact.title}
                      {artifact.main && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">Main report</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground break-all">
                      <span className="font-mono">{artifact.path}</span> · {formatBytes(artifact.size)}
                      {!artifact.listed && " · not listed in report"}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      nativeButton={false}
                      render={
                        <a
                          href={artifactUrl(id, runId, artifact.path)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View ${artifact.path}`}
                        />
                      }
                    >
                      View
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      nativeButton={false}
                      render={
                        <a
                          href={artifactUrl(id, runId, artifact.path, true)}
                          aria-label={`Download ${artifact.path}`}
                        />
                      }
                    >
                      Download
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {run.artifacts_truncated && (
            <p className="text-xs text-muted-foreground">
              Some files weren&apos;t kept because the run went over its size limit.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Slack messages</CardTitle>
          </CardHeader>
          <CardContent>
            {slackMessages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Slack messages.</p>
            ) : (
              <ul className="space-y-3">
                {slackMessages.map((message, index) => (
                  <li key={index} className="space-y-1 rounded-lg border p-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{channelLabel(message.channel)}</span>
                      {message.kind === "failure_notice" && (
                        <Pill className="border border-border text-foreground">Failure notice</Pill>
                      )}
                      <span className="text-xs">
                        <SlackStatus message={message} />
                      </span>
                    </div>
                    {message.status === "refused" && message.error && (
                      <p className="text-xs text-muted-foreground">{message.error}</p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    {message.attachments.length > 0 && (
                      <p className="text-xs text-muted-foreground break-all">
                        Attachments:{" "}
                        {message.attachments.map((path, i) => (
                          <span key={path}>
                            {i > 0 && ", "}
                            <span className="font-mono">{path}</span>
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Secrets used</CardTitle>
          </CardHeader>
          <CardContent>
            {secretsUsed.length === 0 ? (
              <p className="text-sm text-muted-foreground">No secrets.</p>
            ) : (
              <ul className="space-y-1">
                {secretsUsed.map((secret) => (
                  <li key={`${secret.scope}-${secret.name}`} className="text-sm">
                    <span className="font-mono text-xs">{secret.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">{secret.scope}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
