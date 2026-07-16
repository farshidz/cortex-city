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
import {
  formatExpiry,
  formatResetTime,
  presentQuota,
  type QuotaBar,
  type QuotaResetCredits,
  type QuotaSeverity,
} from "@/lib/quota-presentation";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const RUNTIMES: AgentRuntime[] = ["codex", "claude"];

function humanizeQuotaKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const SEVERITY_BAR_CLASSES: Record<QuotaSeverity, string> = {
  normal: "bg-green-500",
  warning: "bg-yellow-500",
  critical: "bg-red-500",
};

function UsageBar({ bar, now }: { bar: QuotaBar; now: number }) {
  const reset = formatResetTime(bar.resetsAtMs, now);
  const width = bar.usedPercent == null ? 0 : Math.min(100, Math.max(0, bar.usedPercent));
  const detail = bar.note ?? reset;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{bar.label}</span>
          {bar.sublabel ? (
            <span className="text-xs text-muted-foreground">{bar.sublabel}</span>
          ) : null}
        </div>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="text-right text-sm tabular-nums text-muted-foreground">
        {bar.usedPercent == null ? "—" : `${bar.usedPercent}% used`}
      </div>
      <div className="col-span-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", SEVERITY_BAR_CLASSES[bar.severity])}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function ResetCredits({ data }: { data: QuotaResetCredits }) {
  return (
    <div className="grid gap-2 border-t border-foreground/10 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Resets available
        </span>
        <Badge variant="secondary">{data.availableCount}</Badge>
      </div>
      {data.credits.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {data.credits.map((credit) => (
            <li key={credit.key} className="flex items-center justify-between gap-4">
              <span className="truncate">{credit.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatExpiry(credit.expiresAtMs)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        // Codex may report only a count (credits: null); the badge is authoritative.
        <div className="text-sm text-muted-foreground">Reset details unavailable.</div>
      )}
    </div>
  );
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
            const view = presentQuota(runtime, quotaStatus?.quota);
            const description = [
              view.planLabel,
              quotaStatus
                ? `Updated ${new Date(quotaStatus.fetched_at).toLocaleTimeString()}`
                : "Reading quota status",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Card key={runtime} size="sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle>{humanizeQuotaKey(runtime)}</CardTitle>
                      <CardDescription>{description}</CardDescription>
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
                <CardContent className="grid gap-4">
                  {state === "available" && !view.empty ? (
                    <>
                      {view.sections.map((section) => (
                        <div key={section.key} className="grid gap-3">
                          {section.title ? (
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {section.title}
                            </div>
                          ) : null}
                          {section.bars.map((bar) => (
                            <UsageBar key={bar.key} bar={bar} now={now} />
                          ))}
                        </div>
                      ))}
                      {view.resetCredits ? <ResetCredits data={view.resetCredits} /> : null}
                      {quotaStatus?.message ? (
                        <div className="text-xs text-muted-foreground">{quotaStatus.message}</div>
                      ) : null}
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {quotaStatus?.message ||
                        (state === "available"
                          ? "No quota data to display."
                          : "Loading quota status...")}
                    </div>
                  )}
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
