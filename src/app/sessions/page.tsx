"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  ActiveSession,
  AgentQuotaStatus,
  AgentRuntime,
  OrchestratorStatus,
} from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const RUNTIMES: AgentRuntime[] = ["codex", "claude"];

function humanizeQuotaKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatQuotaValue(key: string, value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/percent|utilization/i.test(key)) return `${value.toLocaleString()}%`;
    if (/duration.*mins/i.test(key)) {
      const hours = value / 60;
      return Number.isInteger(hours / 24)
        ? `${hours / 24} days`
        : Number.isInteger(hours)
          ? `${hours} hours`
          : `${value} minutes`;
    }
    if (/(resets|expires|granted).*at/i.test(key)) {
      return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toLocaleString();
    }
    return value.toLocaleString();
  }
  if (/(resets|expires|granted).*at/i.test(key)) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toLocaleString();
  }
  return value;
}

function QuotaDetails({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <div className="grid gap-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-md border p-2">
            <QuotaDetails value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item != null);
    if (entries.length === 0) {
      return <span className="text-muted-foreground">No data</span>;
    }
    return (
      <div className="grid gap-2">
        {entries.map(([key, item]) =>
          item && typeof item === "object" ? (
            <div key={key} className="rounded-md border p-2">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {humanizeQuotaKey(key)}
              </div>
              <QuotaDetails value={item} />
            </div>
          ) : (
            <div key={key} className="flex items-start justify-between gap-4">
              <span className="text-muted-foreground">{humanizeQuotaKey(key)}</span>
              <span className="text-right font-medium">
                {formatQuotaValue(key, item as string | number | boolean)}
              </span>
            </div>
          )
        )}
      </div>
    );
  }
  return <span>{value == null ? "No data" : String(value)}</span>;
}

export default function SessionsPage() {
  const { data: sessions, mutate: mutateSessions } = useSWR<ActiveSession[]>(
    "/api/sessions",
    fetcher,
    { refreshInterval: 3000 }
  );
  const { data: status } = useSWR<OrchestratorStatus>(
    "/api/orchestrator",
    fetcher,
    { refreshInterval: 3000 }
  );
  const { data: agentQuotaStatuses } = useSWR<AgentQuotaStatus[]>(
    "/api/agent-status",
    fetcher,
    { refreshInterval: 60_000 }
  );
  const [now, setNow] = useState(() => Date.now());
  const [recovering, setRecovering] = useState(false);
  const autoRecoveryAttemptedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!status) return;
    if (status.healthy) {
      autoRecoveryAttemptedRef.current = false;
      return;
    }
    if (!status.autostart_enabled) return;
    if (autoRecoveryAttemptedRef.current) return;
    autoRecoveryAttemptedRef.current = true;
    void fetch("/api/orchestrator", { method: "POST" });
  }, [status]);

  async function killSession(session: ActiveSession) {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: session.task_id,
        kind: session.kind,
        run_kind: session.run_kind,
      }),
    });
    mutateSessions();
  }

  async function triggerWorker() {
    setRecovering(true);
    await fetch("/api/orchestrator", { method: "POST" });
    setRecovering(false);
  }

  function formatDuration(startedAt: string): string {
    const seconds = Math.floor((now - new Date(startedAt).getTime()) / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  const statusLabel = !status
    ? "Loading"
    : status.worker_healthy
      ? status.poll_in_progress
        ? "Polling"
        : "Running"
      : status.autostart_enabled && recovering
        ? "Starting"
        : "Stopped";

  const statusVariant =
    statusLabel === "Stopped"
      ? "destructive"
      : statusLabel === "Starting"
        ? "secondary"
        : "default";

  const controlLabel = !status
    ? "Loading..."
    : status.worker_healthy
      ? "Request Poll"
      : status.autostart_enabled
        ? recovering
          ? "Starting..."
          : "Start Worker"
        : "Managed Externally";

  const controlDisabled =
    !status || recovering || (!status.worker_healthy && !status.autostart_enabled);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Sessions</h1>
        <Button variant="outline" onClick={triggerWorker} disabled={controlDisabled}>
          {controlLabel}
        </Button>
      </div>

      {/* Status bar */}
      <Card className="mb-4">
        <CardContent className="py-3">
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Status:</span>
              <Badge variant={statusVariant}>{statusLabel}</Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Active: </span>
              <span className="font-medium">
                {status?.active_sessions || 0} / {status?.max_sessions || 0}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Last poll: </span>
              <span>
                {status?.last_poll_at
                  ? new Date(status.last_poll_at).toLocaleTimeString()
                  : "Never"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Heartbeat: </span>
              <span>
                {status?.last_heartbeat_at
                  ? new Date(status.last_heartbeat_at).toLocaleTimeString()
                  : "Never"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Poll phase: </span>
              <span>
                {status?.poll_in_progress
                  ? `running since ${
                      status.poll_started_at
                        ? new Date(status.poll_started_at).toLocaleTimeString()
                        : "unknown"
                    }`
                  : "idle"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Worker start: </span>
              <span>{status?.autostart_enabled ? "ui autostart" : "external"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4">
        <h2 className="mb-3 text-lg font-semibold">Agent quota status</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {RUNTIMES.map((runtime) => {
            const quotaStatus = agentQuotaStatuses?.find(
              (candidate) => candidate.runtime === runtime
            );
            const state = quotaStatus?.state || "loading";
            return (
              <Card key={runtime} size="sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle>{humanizeQuotaKey(runtime)}</CardTitle>
                      <CardDescription>
                        {quotaStatus
                          ? `Updated ${new Date(quotaStatus.fetched_at).toLocaleTimeString()}`
                          : "Reading quota status"}
                      </CardDescription>
                    </div>
                    <Badge
                      variant={
                        state === "error"
                          ? "destructive"
                          : state === "available"
                            ? "default"
                            : "secondary"
                      }
                    >
                      {humanizeQuotaKey(state)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="max-h-96 overflow-auto">
                  {quotaStatus?.quota ? (
                    <QuotaDetails value={quotaStatus.quota} />
                  ) : (
                    <div className="text-muted-foreground">
                      {quotaStatus?.message || "Loading quota status..."}
                    </div>
                  )}
                  {quotaStatus?.quota && quotaStatus.message ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      {quotaStatus.message}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Session cards */}
      {sessions && sessions.length > 0 ? (
        <div className="grid gap-3">
          {sessions.map((session) => (
            <Card
              key={`${session.kind}:${session.run_kind || "run"}:${session.task_id}`}
            >
              <CardHeader className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Badge variant={session.kind === "review" ? "secondary" : "default"}>
                      {session.run_kind === "review_retro"
                        ? "Review retro"
                        : session.kind === "review"
                          ? "Review"
                          : "Task"}
                    </Badge>
                    <span>{session.task_title}</span>
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => killSession(session)}
                  >
                    Kill
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="py-2">
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-muted-foreground">
                      {session.kind === "review" ? "Runtime: " : "Agent: "}
                    </span>
                    <Badge variant="outline">{session.agent}</Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground">PID: </span>
                    <span className="font-mono">{session.pid}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Duration: </span>
                    <span>{formatDuration(session.started_at)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Session: </span>
                    <span className="font-mono text-xs">
                      {session.session_id === "pending"
                        ? "pending"
                        : session.session_id.slice(0, 8)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No active sessions.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
