"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RoutineSummary } from "@/lib/routine-api";
import {
  formatEffortLabel,
  getDefaultEffortForRuntime,
  getDefaultModelForRuntime,
  getEffortOptions,
} from "@/lib/runtime-config";
import type {
  AgentRuntime,
  OrchestratorConfig,
  RoutineRun,
  RoutineRunStatus,
  SecretMetadata,
  TaskEffort,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export type { RoutineSummary };

export interface RoutineDetail {
  routine: RoutineSummary;
  runs: RoutineRun[];
  secrets: SecretMetadata[];
  next_runs: string[];
}

export interface GlobalSecret extends SecretMetadata {
  used_by: { id: string; name: string; overridden: boolean }[];
}

export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_KEEP_RUNS = 30;
export const DEFAULT_MAX_RUN_MB = 100;
const DEFAULT_VALUE = "__default__";

export const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Fetches JSON and turns a non-2xx `{error}` body into a thrown Error. */
export async function apiRequest<T = unknown>(
  url: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (data && typeof data.error === "string" && data.error) ||
        `Request failed (${response.status}).`,
    );
  }
  return data as T;
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// --- Formatting ---

export function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(start?: string, end?: string): string {
  if (!start) return "—";
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatTokens(n?: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function runtimeLabel(runtime?: AgentRuntime): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  return "Default";
}

/** "#name" for channel names; channel IDs (C0123ABCD) are shown as-is. */
export function channelLabel(channel: string): string {
  if (channel.startsWith("#") || /^[CG][A-Z0-9]{6,}$/.test(channel)) return channel;
  return `#${channel}`;
}

export function isActiveRun(status?: RoutineRunStatus): boolean {
  return status === "queued" || status === "running";
}

/** Builds an artifact URL, encoding each path segment on its own. */
export function artifactUrl(
  routineId: string,
  runId: string,
  path: string,
  download = false,
): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/artifacts/${encoded}${download ? "?download=1" : ""}`;
}

/** Parses a number input; blank means "use the default" (sent as null). */
export function optionalInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

// --- Status pills ---

const STATUS_STYLES: Record<RoutineRunStatus, { label: string; className: string }> = {
  succeeded: {
    label: "Succeeded",
    className: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300",
  },
  running: {
    label: "Running",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
  },
  queued: {
    label: "Queued",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
  },
  needs_attention: {
    label: "Needs attention",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  },
  timeout: {
    label: "Timed out",
    className: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  },
  skipped: {
    label: "Skipped",
    className: "bg-gray-100 text-gray-700 dark:bg-gray-500/15 dark:text-gray-300",
  },
};

export function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function RunStatusPill({ status }: { status: RoutineRunStatus }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.skipped;
  return <Pill className={style.className}>{style.label}</Pill>;
}

export function EnabledPill({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Pill className={STATUS_STYLES.succeeded.className}>Enabled</Pill>
  ) : (
    <Pill className={STATUS_STYLES.skipped.className}>Paused</Pill>
  );
}

export const AMBER_BADGE =
  "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300";

// --- Schedule ---

export const SCHEDULE_PRESETS = [
  { value: "hourly", label: "Hourly", cron: "0 * * * *" },
  { value: "daily", label: "Daily at 9:00", cron: "0 9 * * *" },
  { value: "weekdays", label: "Weekdays at 9:00", cron: "0 9 * * 1-5" },
  { value: "weekly", label: "Weekly on Monday at 9:00", cron: "0 9 * * 1" },
  { value: "monthly", label: "Monthly on the 1st at 9:00", cron: "0 9 1 * *" },
] as const;

function normalizeCron(cron: string): string {
  return cron.trim().replace(/\s+/g, " ");
}

/** A plain-English name for a cron expression when it matches a preset. */
export function describeCron(cron: string): string | undefined {
  const normalized = normalizeCron(cron);
  return SCHEDULE_PRESETS.find((preset) => preset.cron === normalized)?.label;
}

const subscribeNothing = () => () => {};

/** The browser's IANA timezone, or "" while rendering on the server. */
export function useBrowserTimezone(): string {
  return useSyncExternalStore(
    subscribeNothing,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => "",
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

async function previewFetcher(url: string): Promise<string[]> {
  const data = await apiRequest<{ next_runs: string[] }>(url, "GET");
  return data.next_runs;
}

export function ScheduleFields({
  idPrefix,
  cron,
  timezone,
  onCronChange,
  onTimezoneChange,
  paused,
}: {
  idPrefix: string;
  cron: string;
  timezone: string;
  onCronChange: (cron: string) => void;
  onTimezoneChange: (timezone: string) => void;
  paused?: boolean;
}) {
  const [forceCustom, setForceCustom] = useState(false);
  const matched = SCHEDULE_PRESETS.find((preset) => preset.cron === normalizeCron(cron));
  const presetValue = forceCustom || !matched ? "custom" : matched.value;
  const query = useDebounced(`cron=${encodeURIComponent(cron)}&timezone=${encodeURIComponent(timezone)}`, 400);
  const ready = cron.trim() !== "" && timezone.trim() !== "";
  const { data: nextRuns, error, isLoading } = useSWR(
    ready ? `/api/routines/schedule-preview?${query}` : null,
    previewFetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-repeat`}>Repeat</Label>
          <Select
            value={presetValue}
            onValueChange={(value) => {
              if (!value) return;
              if (value === "custom") {
                setForceCustom(true);
                document.getElementById(`${idPrefix}-cron`)?.focus();
                return;
              }
              const preset = SCHEDULE_PRESETS.find((entry) => entry.value === value);
              if (!preset) return;
              setForceCustom(false);
              onCronChange(preset.cron);
            }}
          >
            <SelectTrigger id={`${idPrefix}-repeat`} className="w-full">
              <SelectValue>
                {presetValue === "custom" ? "Custom" : matched?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-cron`}>Cron</Label>
          <Input
            id={`${idPrefix}-cron`}
            className="font-mono"
            value={cron}
            onChange={(e) => onCronChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            autoComplete="off"
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-timezone`}>Timezone</Label>
        <Input
          id={`${idPrefix}-timezone`}
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          placeholder="Europe/London"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${idPrefix}-timezone-help`}
        />
        <p id={`${idPrefix}-timezone-help`} className="text-xs text-muted-foreground">
          An IANA timezone name, like America/New_York or UTC.
        </p>
      </div>
      <div aria-live="polite" className="text-sm">
        {!ready ? null : error ? (
          <p role="alert" className="text-destructive">
            {errorMessage(error, "Couldn't read this schedule.")}
          </p>
        ) : nextRuns && nextRuns.length > 0 ? (
          <div>
            <p className="font-medium">
              Next runs{paused ? " (when resumed)" : ""}:
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {nextRuns.map((iso, index) => (
                <li key={`${index}-${iso}`}>{formatDateTime(iso)}</li>
              ))}
            </ul>
          </div>
        ) : isLoading ? (
          <p className="text-muted-foreground">Checking schedule…</p>
        ) : null}
      </div>
    </div>
  );
}

// --- Agent ---

export interface AgentFormValue {
  agent_runner: AgentRuntime | "";
  model: string;
  effort: TaskEffort | "";
  timeout_minutes: string;
}

export function agentPayload(value: AgentFormValue) {
  return {
    agent_runner: value.agent_runner || null,
    model: value.model.trim() || null,
    effort: value.effort || null,
    timeout_minutes: optionalInteger(value.timeout_minutes),
  };
}

export function AgentFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: AgentFormValue;
  onChange: (value: AgentFormValue) => void;
}) {
  const { data: config } = useSWR<OrchestratorConfig>("/api/config", fetcher);
  const defaultRuntime: AgentRuntime = config?.default_agent_runner || "claude";
  const runtime = value.agent_runner || defaultRuntime;
  const effortOptions = getEffortOptions(runtime);
  const defaultModel = config ? getDefaultModelForRuntime(config, runtime) : "";
  const defaultEffort = config ? getDefaultEffortForRuntime(config, runtime) : undefined;

  function setRuntime(next: string | null) {
    const agent_runner = next === "claude" || next === "codex" ? next : "";
    const nextRuntime = agent_runner || defaultRuntime;
    const keepEffort =
      value.effort && getEffortOptions(nextRuntime).some((option) => option.value === value.effort);
    onChange({
      ...value,
      agent_runner,
      ...(agent_runner !== value.agent_runner ? { model: "" } : {}),
      effort: keepEffort ? value.effort : "",
    });
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-runtime`}>Runtime</Label>
        <Select value={value.agent_runner || DEFAULT_VALUE} onValueChange={setRuntime}>
          <SelectTrigger id={`${idPrefix}-runtime`} className="w-full">
            <SelectValue>
              {value.agent_runner
                ? runtimeLabel(value.agent_runner)
                : `Default (${runtimeLabel(defaultRuntime)})`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VALUE}>
              Default ({runtimeLabel(defaultRuntime)})
            </SelectItem>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <Input
          id={`${idPrefix}-model`}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          placeholder={defaultModel || "Runtime default"}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-effort`}>Effort</Label>
        <Select
          value={value.effort || DEFAULT_VALUE}
          onValueChange={(next) =>
            onChange({
              ...value,
              effort: !next || next === DEFAULT_VALUE ? "" : (next as TaskEffort),
            })
          }
        >
          <SelectTrigger id={`${idPrefix}-effort`} className="w-full">
            <SelectValue>
              {value.effort
                ? formatEffortLabel(value.effort)
                : `Default (${formatEffortLabel(defaultEffort)})`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VALUE}>
              Default ({formatEffortLabel(defaultEffort)})
            </SelectItem>
            {effortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-timeout`}>Timeout (minutes)</Label>
        <Input
          id={`${idPrefix}-timeout`}
          type="number"
          min={1}
          max={1440}
          inputMode="numeric"
          value={value.timeout_minutes}
          onChange={(e) => onChange({ ...value, timeout_minutes: e.target.value })}
          placeholder={String(DEFAULT_TIMEOUT_MINUTES)}
        />
      </div>
    </div>
  );
}
