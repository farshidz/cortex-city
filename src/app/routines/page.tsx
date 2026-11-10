"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  apiRequest,
  describeCron,
  errorMessage,
  fetcher,
  formatDateTime,
  RunStatusPill,
  type RoutineSummary,
} from "./routine-ui";

function promptPreview(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

export default function RoutinesPage() {
  const { data, error, mutate } = useSWR<RoutineSummary[]>("/api/routines", fetcher, {
    refreshInterval: 5000,
  });
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const routines = Array.isArray(data) ? data : undefined;

  async function setEnabled(routine: RoutineSummary, enabled: boolean) {
    setBusy(routine.id);
    setMessage(null);
    try {
      await apiRequest(`/api/routines/${routine.id}`, "PUT", { enabled });
      await mutate();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err, "Couldn't update the routine.") });
    } finally {
      setBusy(null);
    }
  }

  async function runNow(routine: RoutineSummary) {
    setBusy(routine.id);
    setMessage(null);
    try {
      const result = await apiRequest<{ worker_notified?: boolean }>(
        `/api/routines/${routine.id}/run`,
        "POST",
      );
      setMessage({
        tone: "info",
        text: `Run requested for “${routine.name}”.${
          result.worker_notified === false ? " It starts on the worker's next poll." : ""
        }`,
      });
      await mutate();
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err, "Couldn't start the run.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Routines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduled agent runs that produce reports or take actions.
          </p>
        </div>
        <Button render={<Link href="/routines/new" />} nativeButton={false}>
          New routine
        </Button>
      </div>

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={
            message.tone === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {message.text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load routines.
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Last status</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {routines?.map((routine) => {
            const preset = describeCron(routine.cron);
            const running = Boolean(routine.active_run_id);
            const lastRunAt = routine.last_run?.started_at ?? routine.last_run?.created_at;
            return (
              <TableRow key={routine.id}>
                <TableCell className="max-w-xs whitespace-normal">
                  <Link href={`/routines/${routine.id}`} className="font-medium hover:underline">
                    {routine.name}
                  </Link>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {promptPreview(routine.prompt)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-mono text-xs">{routine.cron}</div>
                  <div className="text-xs text-muted-foreground">
                    {preset ? `${preset} · ` : ""}
                    {routine.timezone}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {routine.enabled ? (
                    formatDateTime(routine.next_run_at)
                  ) : (
                    <span className="text-muted-foreground">Paused</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {running ? (
                    <Link
                      href={`/routines/${routine.id}/runs/${routine.active_run_id}`}
                      className="hover:underline"
                    >
                      Running…
                    </Link>
                  ) : routine.last_run ? (
                    <Link
                      href={`/routines/${routine.id}/runs/${routine.last_run.id}`}
                      className="hover:underline"
                    >
                      {formatDateTime(lastRunAt)}
                    </Link>
                  ) : (
                    "Never"
                  )}
                </TableCell>
                <TableCell>
                  {routine.last_run ? (
                    <RunStatusPill status={routine.last_run.status} />
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={routine.enabled}
                    disabled={busy === routine.id}
                    onCheckedChange={(checked) => setEnabled(routine, checked)}
                    aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === routine.id || Boolean(routine.run_requested_at)}
                    onClick={() => runNow(routine)}
                    aria-label={`Run ${routine.name} now`}
                  >
                    {routine.run_requested_at ? "Requested" : "Run now"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {routines && routines.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                No routines yet.{" "}
                <Link href="/routines/new" className="underline">
                  Create your first routine
                </Link>
                .
              </TableCell>
            </TableRow>
          )}
          {!routines && !error && (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
