import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import readline from "readline";
import type { AgentQuotaStatus, AgentRuntime } from "./types";

const CODEX_STATUS_CACHE_TTL_MS = 60_000;
const CLAUDE_STATUS_CACHE_TTL_MS = 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 12_000;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface CodexStatusOptions {
  spawnCodex?: () => ChildProcessWithoutNullStreams;
  now?: () => Date;
  timeoutMs?: number;
}

interface ClaudeStatusOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  homedir?: () => string;
  now?: () => Date;
  readFileImpl?: typeof readFile;
  timeoutMs?: number;
}

interface AgentQuotaStatusesOptions {
  getClaudeStatus?: () => Promise<AgentQuotaStatus>;
  getCodexStatus?: () => Promise<AgentQuotaStatus>;
  nowMs?: () => number;
}

class ProviderUnavailableError extends Error {}

const statusCache = new Map<
  AgentRuntime,
  { expiresAt: number; status: AgentQuotaStatus }
>();
const statusRequests = new Map<AgentRuntime, Promise<AgentQuotaStatus>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableStatus(
  runtime: AgentRuntime,
  error: unknown,
  now: () => Date
): AgentQuotaStatus {
  return {
    runtime,
    state: error instanceof ProviderUnavailableError ? "unavailable" : "error",
    fetched_at: now().toISOString(),
    message: errorMessage(error),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function rpcError(response: JsonRpcResponse): string | undefined {
  return response.error?.message || (response.error ? "Unknown app-server error" : undefined);
}

function readCodexQuota(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ quota: Record<string, unknown>; message?: string }> {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const responses = new Map<number, JsonRpcResponse>();
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      lines.close();
      if (!child.killed) child.kill();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    const finish = () => {
      const rateLimits = responses.get(2);
      const usage = responses.get(3);
      if (!rateLimits || !usage) return;

      const errors = [rpcError(rateLimits), rpcError(usage)].filter(
        (message): message is string => Boolean(message)
      );
      const rateLimitResult = asRecord(rateLimits.result);
      const usageResult = asRecord(usage.result);
      if (!rateLimitResult && !usageResult) {
        fail(new Error(errors.join("; ") || "Codex returned no quota data"));
        return;
      }

      const quota: Record<string, unknown> = {};
      if (rateLimitResult) {
        quota.rate_limits =
          rateLimitResult.rateLimitsByLimitId ?? rateLimitResult.rateLimits;
        if (rateLimitResult.rateLimitResetCredits != null) {
          quota.rate_limit_reset_credits = rateLimitResult.rateLimitResetCredits;
        }
      }
      if (usageResult) {
        quota.usage = usageResult.summary ?? usageResult;
      }

      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        quota,
        message: errors.length > 0 ? errors.join("; ") : undefined,
      });
    };
    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(
      () => fail(new Error("Timed out while reading Codex quota status")),
      timeoutMs
    );

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new ProviderUnavailableError("Codex CLI is not installed"));
        return;
      }
      fail(error);
    });
    child.once("exit", (code) => {
      if (!settled) {
        const detail = stderr.trim();
        fail(
          new Error(
            detail || `Codex app-server exited before responding (code ${code})`
          )
        );
      }
    });
    child.stdin.on("error", fail);
    lines.on("line", (line) => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        fail(new Error("Codex app-server returned invalid JSON"));
        return;
      }

      if (response.id === 1) {
        const message = rpcError(response);
        if (message) {
          fail(new Error(message));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 2 });
        send({ method: "account/usage/read", id: 3 });
        return;
      }
      if (response.id === 2 || response.id === 3) {
        responses.set(response.id, response);
        finish();
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "cortex_city",
          title: "Cortex City",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function getCodexQuotaStatus(
  options: CodexStatusOptions = {}
): Promise<AgentQuotaStatus> {
  const now = options.now || (() => new Date());
  try {
    const child = (options.spawnCodex ||
      (() =>
        spawn("codex", ["app-server", "--stdio"], {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        })))();
    const result = await readCodexQuota(
      child,
      options.timeoutMs ?? PROVIDER_TIMEOUT_MS
    );
    return {
      runtime: "codex",
      state: "available",
      fetched_at: now().toISOString(),
      ...result,
    };
  } catch (error) {
    return unavailableStatus("codex", error, now);
  }
}

function claudeUsageError(status: number, body: unknown, retryAfter: string | null) {
  const record = asRecord(body);
  const apiError = asRecord(record?.error);
  const apiMessage = typeof apiError?.message === "string" ? apiError.message : undefined;
  if (status === 401 || status === 403) {
    return new ProviderUnavailableError(
      "Claude login cannot access quota status; run `claude auth login` again"
    );
  }
  if (status === 429) {
    return new Error(
      `Claude quota endpoint is rate limited${
        retryAfter ? `; retry after ${retryAfter}` : "; retry later"
      }`
    );
  }
  return new Error(apiMessage || `Claude quota request failed (${status})`);
}

export async function getClaudeQuotaStatus(
  options: ClaudeStatusOptions = {}
): Promise<AgentQuotaStatus> {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const fetchImpl = options.fetchImpl || fetch;
  const readFileImpl = options.readFileImpl || readFile;
  const homedir = options.homedir || os.homedir;

  try {
    let token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    let subscriptionType: string | undefined;
    let rateLimitTier: string | undefined;
    if (!token) {
      const configDir = env.CLAUDE_CONFIG_DIR
        ? path.resolve(env.CLAUDE_CONFIG_DIR)
        : path.join(homedir(), ".claude");
      let credentials: ClaudeCredentials;
      try {
        credentials = JSON.parse(
          await readFileImpl(path.join(configDir, ".credentials.json"), "utf8")
        ) as ClaudeCredentials;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ProviderUnavailableError("Claude is not logged in");
        }
        throw error;
      }
      token = credentials.claudeAiOauth?.accessToken?.trim();
      subscriptionType = credentials.claudeAiOauth?.subscriptionType;
      rateLimitTier = credentials.claudeAiOauth?.rateLimitTier;
    }
    if (!token) {
      throw new ProviderUnavailableError(
        "Claude subscription quota requires a claude.ai login"
      );
    }

    const baseUrl = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const response = await fetchImpl(new URL("/api/oauth/usage", baseUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "cortex-city/agent-status",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw claudeUsageError(
        response.status,
        body,
        response.headers.get("retry-after")
      );
    }

    const quota = asRecord(body);
    if (!quota) throw new Error("Claude returned invalid quota data");
    if (subscriptionType || rateLimitTier) {
      quota.account = {
        ...(subscriptionType ? { subscription_type: subscriptionType } : {}),
        ...(rateLimitTier ? { rate_limit_tier: rateLimitTier } : {}),
      };
    }
    return {
      runtime: "claude",
      state: "available",
      fetched_at: now().toISOString(),
      quota,
    };
  } catch (error) {
    return unavailableStatus("claude", error, now);
  }
}

export async function getAgentQuotaStatuses(
  options: AgentQuotaStatusesOptions = {}
): Promise<AgentQuotaStatus[]> {
  const nowMs = options.nowMs || Date.now;
  const getCachedStatus = (
    runtime: AgentRuntime,
    load: () => Promise<AgentQuotaStatus>,
    successTtlMs: number
  ) => {
    const cached = statusCache.get(runtime);
    if (cached && cached.expiresAt > nowMs()) return Promise.resolve(cached.status);
    const activeRequest = statusRequests.get(runtime);
    if (activeRequest) return activeRequest;

    const request = load()
      .then((status) => {
        const retryAfter = status.message?.match(/retry after (\d+)/i)?.[1];
        const ttlMs = retryAfter
          ? Math.max(Number(retryAfter) * 1000, CODEX_STATUS_CACHE_TTL_MS)
          : status.state === "available"
            ? successTtlMs
            : CODEX_STATUS_CACHE_TTL_MS;
        statusCache.set(runtime, {
          expiresAt: nowMs() + ttlMs,
          status,
        });
        return status;
      })
      .finally(() => {
        statusRequests.delete(runtime);
      });
    statusRequests.set(runtime, request);
    return request;
  };

  return Promise.all([
    getCachedStatus(
      "codex",
      options.getCodexStatus || getCodexQuotaStatus,
      CODEX_STATUS_CACHE_TTL_MS
    ),
    getCachedStatus(
      "claude",
      options.getClaudeStatus || getClaudeQuotaStatus,
      CLAUDE_STATUS_CACHE_TTL_MS
    ),
  ]);
}
