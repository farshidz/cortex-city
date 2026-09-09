import { appendFileSync, createReadStream, mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

export interface ReviewTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

let deploymentRevision: string | undefined;
function revision(): string {
  if (deploymentRevision) return deploymentRevision;
  try { deploymentRevision = JSON.parse(readFileSync(path.join(process.cwd(), ".next", "required-server-files.json"), "utf8")).config?.env?.NEXT_PUBLIC_CORTEX_COMMIT_SHA; } catch {}
  return deploymentRevision || process.env.CORTEX_COMMIT_SHA || "unknown";
}

export function recordRunEvent(event: Record<string, unknown>): void {
  const at = new Date().toISOString();
  try {
    const directory = path.join(process.cwd(), "logs");
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, `run-events-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, deployment_revision: revision(), ...event }) + "\n");
  } catch (error) {
    console.error("[run-telemetry] Could not persist run event:", error);
  }
}

function tokenUsage(value: unknown): ReviewTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as ReviewTokenUsage;
  if (![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)) return undefined;
  if (usage.cached_input_tokens > usage.input_tokens) return undefined;
  return { input_tokens: usage.input_tokens, cached_input_tokens: usage.cached_input_tokens, output_tokens: usage.output_tokens };
}

export function claudeRoundUsage(usage: Record<string, unknown> | undefined): ReviewTokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  if (![input, cached, written].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  return tokenUsage({input_tokens: (input as number) + (cached as number) + (written as number), cached_input_tokens: cached, output_tokens: usage.output_tokens});
}

// Read the invocation's native per-request records, rather than subtracting
// session totals. This also measures failed turns and avoids Q&A contamination
// and cumulative-counter resets. Stream the rollout so large sessions stay bounded.
export async function readCodexRoundUsage(sessionId: string | undefined, startedAt: number, finishedAt: number, codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex")): Promise<{
  usage?: ReviewTokenUsage; status: string; turn_ids?: string[]; response_count?: number;
}> {
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return { status: "missing_session" };
  try {
    const root = path.join(codexHome, "sessions");
    const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(`-${sessionId}.jsonl`));
    if (files.length !== 1) return { status: "missing_or_ambiguous_rollout" };
    const lines = createInterface({input: createReadStream(path.join(root, files[0])), crlfDelay: Infinity});
    const turns = new Set<string>();
    const responses = new Set<string>();
    const total: ReviewTokenUsage = {input_tokens: 0, cached_input_tokens: 0, output_tokens: 0};
    let invalid = false;
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { invalid = true; continue; }
      const time = Date.parse(event.timestamp);
      if (!Number.isFinite(time) || time < startedAt || time > finishedAt) continue;
      const payload = event.payload;
      if (event.type === "event_msg" && payload?.type === "task_started" && typeof payload.turn_id === "string") turns.add(payload.turn_id);
      if (event.type !== "token_usage_record" || !turns.has(payload?.turn_id) || payload.thread_id !== sessionId) continue;
      const usage = tokenUsage(payload.usage);
      if (!usage || typeof payload.response_id !== "string") { invalid = true; continue; }
      if (responses.has(payload.response_id)) continue;
      responses.add(payload.response_id);
      total.input_tokens += usage.input_tokens;
      total.cached_input_tokens += usage.cached_input_tokens;
      total.output_tokens += usage.output_tokens;
    }
    return {
      status: invalid ? "invalid_records" : responses.size ? "native_request_usage" : "no_request_records",
      usage: !invalid && responses.size ? total : undefined,
      turn_ids: [...turns], response_count: responses.size,
    };
  } catch {
    return { status: "rollout_unavailable" };
  }
}

export function countersReset(before: Partial<ReviewTokenUsage> | undefined, after: Partial<ReviewTokenUsage> | undefined): boolean | undefined {
  if (!before || !after) return undefined;
  return (["input_tokens", "cached_input_tokens", "output_tokens"] as const).some((key) => before[key] !== undefined && after[key] !== undefined && after[key]! < before[key]!);
}
