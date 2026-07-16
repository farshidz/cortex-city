import type { AgentRuntime } from "./types";

export type QuotaSeverity = "normal" | "warning" | "critical";

export interface QuotaBar {
  key: string;
  label: string;
  /** Secondary label shown next to the primary one, e.g. a window type. */
  sublabel?: string;
  /** 0..100, or null when the limit has never been used / percent is unknown. */
  usedPercent: number | null;
  /** Reset time as epoch milliseconds, or null when there is nothing to reset. */
  resetsAtMs: number | null;
  severity: QuotaSeverity;
  /** Shown instead of a reset time, e.g. "Not used yet". */
  note?: string;
}

export interface QuotaSection {
  key: string;
  /** Empty string renders the section without a header. */
  title: string;
  bars: QuotaBar[];
}

export interface QuotaResetCredit {
  key: string;
  title: string;
  expiresAtMs: number | null;
}

export interface QuotaResetCredits {
  availableCount: number;
  credits: QuotaResetCredit[];
}

export interface QuotaView {
  sections: QuotaSection[];
  resetCredits: QuotaResetCredits | null;
  planLabel: string | null;
  empty: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Normalizes epoch seconds, epoch milliseconds, and ISO strings to epoch ms. */
export function toEpochMs(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric != null) {
    // Treat values that are clearly seconds (before year ~2286) as seconds.
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const text = asString(value);
  if (text) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export function severityForPercent(percent: number | null): QuotaSeverity {
  if (percent == null) return "normal";
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "normal";
}

function coerceSeverity(raw: unknown, percent: number | null): QuotaSeverity {
  if (raw === "critical" || raw === "warning" || raw === "normal") return raw;
  return severityForPercent(percent);
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Human label for a Codex rate-limit window given its duration in minutes. */
export function windowLabel(minutes: number): string {
  const knownWindows: Record<number, string> = {
    60: "Hourly",
    300: "5-hour",
    1440: "Daily",
    10080: "Weekly",
    43200: "Monthly",
  };
  if (knownWindows[minutes]) return knownWindows[minutes];
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    if (hours % 24 === 0) return `${hours / 24}-day`;
    return `${hours}-hour`;
  }
  return `${minutes}-min`;
}

/** Relative or absolute reset label, computed against a caller-supplied `now`. */
export function formatResetTime(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs == null) return null;
  const diff = resetsAtMs - nowMs;
  if (diff <= 0) return "Resets soon";
  if (diff < DAY_MS) {
    const totalMinutes = Math.round(diff / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${minutes}m`;
  }
  // Reset boundaries land on :59.86s; round to the nearest minute so they read cleanly.
  const date = new Date(Math.round(resetsAtMs / 60000) * 60000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff < WEEK_MS) {
    return `Resets ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `Resets ${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function formatExpiry(expiresAtMs: number | null): string {
  if (expiresAtMs == null) return "No expiry";
  const date = new Date(expiresAtMs);
  return `Expires ${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function presentCodexResetCredits(raw: unknown): QuotaResetCredits | null {
  const record = asRecord(raw);
  if (!record) return null;
  const rawCredits = Array.isArray(record.credits) ? record.credits : [];
  const credits: QuotaResetCredit[] = rawCredits
    .map(asRecord)
    .filter((credit): credit is Record<string, unknown> => Boolean(credit))
    .filter((credit) => credit.status == null || credit.status === "available")
    .map((credit, index) => ({
      key: asString(credit.id) ?? `credit-${index}`,
      title: asString(credit.title) ?? "Rate limit reset",
      expiresAtMs: toEpochMs(credit.expiresAt),
    }))
    .sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity));
  const availableCount = asNumber(record.availableCount) ?? credits.length;
  if (availableCount <= 0 && credits.length === 0) return null;
  return { availableCount, credits };
}

interface CodexBarDraft {
  bar: QuotaBar;
  windowMinutes: number;
  isNamed: boolean;
}

function isRateLimitWindow(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record != null &&
    (record.usedPercent !== undefined || record.windowDurationMins !== undefined)
  );
}

/**
 * The app-server returns rate limits keyed by limit id, but falls back to a
 * single `RateLimitSnapshot` (windows directly under `primary`/`secondary`)
 * when `rateLimitsByLimitId` is null. Normalize the snapshot into a one-entry
 * map so both shapes iterate the same way.
 */
function normalizeCodexRateLimits(
  rateLimits: Record<string, unknown>
): Record<string, unknown> {
  if (isRateLimitWindow(rateLimits.primary) || isRateLimitWindow(rateLimits.secondary)) {
    return { [asString(rateLimits.limitId) ?? "codex"]: rateLimits };
  }
  return rateLimits;
}

function presentCodexQuota(quota: Record<string, unknown>): QuotaView {
  const rateLimits = asRecord(quota.rate_limits);
  const drafts: CodexBarDraft[] = [];
  let planLabel: string | null = null;

  if (rateLimits) {
    for (const [limitId, rawLimit] of Object.entries(normalizeCodexRateLimits(rateLimits))) {
      const limit = asRecord(rawLimit);
      if (!limit) continue;
      planLabel = planLabel ?? (asString(limit.planType) ? titleCase(String(limit.planType)) : null);
      const limitName = asString(limit.limitName);
      for (const windowKey of ["primary", "secondary"] as const) {
        const window = asRecord(limit[windowKey]);
        if (!window) continue;
        const usedPercent = asNumber(window.usedPercent);
        if (usedPercent == null) continue;
        const windowMinutes = asNumber(window.windowDurationMins);
        const windowName = windowMinutes != null ? windowLabel(windowMinutes) : null;
        const label = limitName ?? (windowName ? `${windowName} limit` : "Usage limit");
        drafts.push({
          bar: {
            key: `${limitId}:${windowKey}`,
            label,
            sublabel: limitName && windowName ? windowName : undefined,
            usedPercent,
            resetsAtMs: toEpochMs(window.resetsAt),
            severity: severityForPercent(usedPercent),
          },
          windowMinutes: windowMinutes ?? Number.MAX_SAFE_INTEGER,
          isNamed: Boolean(limitName),
        });
      }
    }
  }

  // Shorter windows first (5-hour before weekly); default limit before named models.
  drafts.sort(
    (a, b) => a.windowMinutes - b.windowMinutes || Number(a.isNamed) - Number(b.isNamed)
  );
  const bars = drafts.map((draft) => draft.bar);
  const resetCredits = presentCodexResetCredits(quota.rate_limit_reset_credits);

  return {
    sections: bars.length ? [{ key: "codex-limits", title: "Rate limits", bars }] : [],
    resetCredits,
    planLabel,
    empty: bars.length === 0 && !resetCredits,
  };
}

function claudeLimitLabel(limit: Record<string, unknown>): string {
  const kind = asString(limit.kind);
  const group = asString(limit.group);
  if (group === "session" || kind === "session") return "Current session";
  if (kind === "weekly_all") return "All models";
  const scope = asRecord(limit.scope);
  const model = asRecord(scope?.model);
  const modelName = asString(model?.display_name);
  if (modelName) return modelName;
  const surface = asString(scope?.surface);
  if (surface) return titleCase(surface);
  return kind ? titleCase(kind.replace(/^weekly_/, "")) : "Weekly limit";
}

function presentClaudeLimits(limits: unknown[]): QuotaSection[] {
  const sessionBars: QuotaBar[] = [];
  const weeklyBars: QuotaBar[] = [];

  limits.forEach((rawLimit, index) => {
    const limit = asRecord(rawLimit);
    if (!limit) return;
    const percent = asNumber(limit.percent);
    const resetsAtMs = toEpochMs(limit.resets_at);
    const isActive = limit.is_active === true;
    const neverUsed = !isActive && resetsAtMs == null && (percent == null || percent === 0);
    const bar: QuotaBar = {
      // Multiple limits can share a kind (e.g. several weekly_scoped models),
      // so the index keeps React row keys unique within the section.
      key: `${asString(limit.kind) ?? "limit"}-${index}`,
      label: claudeLimitLabel(limit),
      usedPercent: neverUsed ? null : percent,
      resetsAtMs,
      severity: coerceSeverity(limit.severity, percent),
      note: neverUsed ? "Not used yet" : undefined,
    };
    if (asString(limit.group) === "weekly") weeklyBars.push(bar);
    else sessionBars.push(bar);
  });

  const sections: QuotaSection[] = [];
  if (sessionBars.length) sections.push({ key: "session", title: "", bars: sessionBars });
  if (weeklyBars.length) {
    sections.push({ key: "weekly", title: "Weekly limits", bars: weeklyBars });
  }
  return sections;
}

const LEGACY_CLAUDE_LABELS: Record<string, string> = {
  five_hour: "Current session",
  seven_day: "All models",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_oauth_apps: "OAuth apps",
  seven_day_cowork: "Cowork",
};

function presentClaudeLegacy(quota: Record<string, unknown>): QuotaSection[] {
  const sessionBars: QuotaBar[] = [];
  const weeklyBars: QuotaBar[] = [];

  for (const [key, label] of Object.entries(LEGACY_CLAUDE_LABELS)) {
    const window = asRecord(quota[key]);
    if (!window) continue;
    const percent = asNumber(window.utilization);
    const bar: QuotaBar = {
      key,
      label,
      usedPercent: percent,
      resetsAtMs: toEpochMs(window.resets_at),
      severity: severityForPercent(percent),
    };
    if (key === "five_hour") sessionBars.push(bar);
    else weeklyBars.push(bar);
  }

  const sections: QuotaSection[] = [];
  if (sessionBars.length) sections.push({ key: "session", title: "", bars: sessionBars });
  if (weeklyBars.length) {
    sections.push({ key: "weekly", title: "Weekly limits", bars: weeklyBars });
  }
  return sections;
}

function deriveClaudePlan(account: Record<string, unknown> | undefined): string | null {
  const subscription = asString(account?.subscription_type);
  if (subscription) return titleCase(subscription);
  const tier = asString(account?.rate_limit_tier);
  if (tier) return titleCase(tier.replace(/^default_/, ""));
  return null;
}

function presentClaudeQuota(quota: Record<string, unknown>): QuotaView {
  const limits = Array.isArray(quota.limits) ? quota.limits : null;
  const sections =
    limits && limits.length > 0 ? presentClaudeLimits(limits) : presentClaudeLegacy(quota);
  return {
    sections,
    resetCredits: null,
    planLabel: deriveClaudePlan(asRecord(quota.account)),
    empty: sections.every((section) => section.bars.length === 0),
  };
}

/** Transforms a raw provider quota payload into a presentation-ready view model. */
export function presentQuota(
  runtime: AgentRuntime,
  quota: Record<string, unknown> | undefined
): QuotaView {
  if (!quota) {
    return { sections: [], resetCredits: null, planLabel: null, empty: true };
  }
  return runtime === "codex" ? presentCodexQuota(quota) : presentClaudeQuota(quota);
}
