"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ActiveSession, OrchestratorStatus } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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

  async function killSession(taskId: string) {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
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

      {/* Session cards */}
      {sessions && sessions.length > 0 ? (
        <div className="grid gap-3">
          {sessions.map((session) => (
            <Card key={session.task_id}>
              <CardHeader className="py-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {session.task_title}
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => killSession(session.task_id)}
                  >
                    Kill
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="py-2">
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-muted-foreground">Agent: </span>
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
