import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { readFile } from "node:fs/promises";
import type { AgentQuotaStatus } from "./types";
import {
  getAgentQuotaStatuses,
  getClaudeQuotaStatus,
  getCodexQuotaStatus,
} from "./agent-status";

function createCodexProcess(
  respond: (request: Record<string, unknown>) => Record<string, unknown> | undefined
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffered = "";
  let killed = false;

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill() {
      killed = true;
      return true;
    },
  });
  Object.defineProperty(child, "killed", { get: () => killed });
  stdin.on("data", (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      const response = respond(JSON.parse(line) as Record<string, unknown>);
      if (response) stdout.write(`${JSON.stringify(response)}\n`);
    }
  });

  return child;
}

const now = () => new Date("2026-07-16T02:00:00.000Z");

test("Codex quota status includes all named limits, reset credits, and usage summary", async () => {
  const requests: string[] = [];
  const child = createCodexProcess((request) => {
    requests.push(String(request.method));
    if (request.id === 1) return { id: 1, result: { userAgent: "test" } };
    if (request.id === 2) {
      return {
        id: 2,
        result: {
          rateLimitsByLimitId: {
            codex: {
              primary: {
                usedPercent: 25,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
            },
          },
          rateLimitResetCredits: { availableCount: 2 },
        },
      };
    }
    if (request.id === 3) {
      return {
        id: 3,
        result: {
          summary: { lifetimeTokens: 12_345 },
          dailyUsageBuckets: [{ startDate: "2026-07-16", tokens: 100 }],
        },
      };
    }
  });

  const status = await getCodexQuotaStatus({
    now,
    spawnCodex: () => child,
    timeoutMs: 1_000,
  });

  assert.equal(status.state, "available");
  assert.equal(status.fetched_at, "2026-07-16T02:00:00.000Z");
  assert.deepEqual(status.quota, {
    rate_limits: {
      codex: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
      },
    },
    rate_limit_reset_credits: { availableCount: 2 },
    usage: {
      summary: { lifetimeTokens: 12_345 },
      dailyUsageBuckets: [{ startDate: "2026-07-16", tokens: 100 }],
    },
  });
  assert.deepEqual(requests, [
    "initialize",
    "initialized",
    "account/rateLimits/read",
    "account/usage/read",
  ]);
  assert.equal(child.killed, true);
});

test("Codex quota status retains partial data when one app-server method fails", async () => {
  const child = createCodexProcess((request) => {
    if (request.id === 1) return { id: 1, result: {} };
    if (request.id === 2) {
      return { id: 2, result: { rateLimits: { planType: "plus" } } };
    }
    if (request.id === 3) {
      return { id: 3, error: { message: "Usage history unavailable" } };
    }
  });

  const status = await getCodexQuotaStatus({
    now,
    spawnCodex: () => child,
    timeoutMs: 1_000,
  });

  assert.equal(status.state, "available");
  assert.deepEqual(status.quota, { rate_limits: { planType: "plus" } });
  assert.equal(status.message, "Usage history unavailable");
});

test("Codex quota status reports unavailable and malformed app-server responses", async () => {
  const missingChild = createCodexProcess(() => undefined);
  const missing = await getCodexQuotaStatus({
    now,
    spawnCodex: () => {
      queueMicrotask(() =>
        missingChild.emit(
          "error",
          Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
        )
      );
      return missingChild;
    },
    timeoutMs: 1_000,
  });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.message, "Codex CLI is not installed");

  const invalidChild = createCodexProcess(() => undefined);
  const invalid = await getCodexQuotaStatus({
    now,
    spawnCodex: () => {
      queueMicrotask(() =>
        (invalidChild.stdout as PassThrough).write("not-json\n")
      );
      return invalidChild;
    },
    timeoutMs: 1_000,
  });
  assert.equal(invalid.state, "error");
  assert.equal(invalid.message, "Codex app-server returned invalid JSON");
});

test("Codex quota status reports an error when all quota methods fail", async () => {
  const child = createCodexProcess((request) => {
    if (request.id === 1) return { id: 1, result: {} };
    if (request.id === 2) return { id: 2, error: {} };
    if (request.id === 3) return { id: 3, error: { message: "Not logged in" } };
  });

  const status = await getCodexQuotaStatus({
    now,
    spawnCodex: () => child,
    timeoutMs: 1_000,
  });
  assert.equal(status.state, "error");
  assert.equal(status.message, "Unknown app-server error; Not logged in");
});

test("Claude quota status reads OAuth usage without exposing its token", async () => {
  const token = "secret-oauth-token";
  let authorization: string | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(
      JSON.stringify({
        five_hour: { utilization: 12, resets_at: "2026-07-16T05:00:00Z" },
        seven_day: { utilization: 34, resets_at: "2026-07-20T00:00:00Z" },
      }),
      { status: 200 }
    );
  }) as typeof fetch;
  const readFileImpl = (async () =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
    })) as unknown as typeof readFile;

  const status = await getClaudeQuotaStatus({
    env: {},
    fetchImpl,
    homedir: () => "/tmp/test-home",
    now,
    readFileImpl,
  });

  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(status.state, "available");
  assert.deepEqual(status.quota, {
    five_hour: { utilization: 12, resets_at: "2026-07-16T05:00:00Z" },
    seven_day: { utilization: 34, resets_at: "2026-07-20T00:00:00Z" },
    account: {
      subscription_type: "team",
      rate_limit_tier: "default_claude_max_5x",
    },
  });
  assert.equal(JSON.stringify(status).includes(token), false);
});

test("Claude quota status distinguishes missing login and endpoint throttling", async () => {
  const missingCredentials = (async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }) as unknown as typeof readFile;
  const missing = await getClaudeQuotaStatus({
    env: {},
    homedir: () => "/tmp/test-home",
    now,
    readFileImpl: missingCredentials,
  });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.message, "Claude is not logged in");

  const throttled = await getClaudeQuotaStatus({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ error: { message: "Rate limited" } }),
        { status: 429, headers: { "retry-after": "30 seconds" } }
      )) as typeof fetch,
    now,
  });
  assert.equal(throttled.state, "error");
  assert.match(throttled.message || "", /retry after 30 seconds/);
});

test("Claude quota status handles expired login and invalid success data", async () => {
  const expired = await getClaudeQuotaStatus({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "expired" },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
      })) as typeof fetch,
    now,
  });
  assert.equal(expired.state, "unavailable");
  assert.match(expired.message || "", /claude auth login/);

  const invalid = await getClaudeQuotaStatus({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
    fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    now,
  });
  assert.equal(invalid.state, "error");
  assert.equal(invalid.message, "Claude returned invalid quota data");

  const noToken = await getClaudeQuotaStatus({
    env: {},
    now,
    readFileImpl: (async () =>
      JSON.stringify({ claudeAiOauth: {} })) as unknown as typeof readFile,
  });
  assert.equal(noToken.state, "unavailable");
  assert.match(noToken.message || "", /requires a claude.ai login/);
});

test("combined agent quota status uses provider-specific cache lifetimes", async () => {
  let currentTime = 1_000;
  let codexCalls = 0;
  let claudeCalls = 0;
  const codexStatus: AgentQuotaStatus = {
    runtime: "codex",
    state: "available",
    fetched_at: now().toISOString(),
    quota: { rate_limits: {} },
  };
  const claudeStatus: AgentQuotaStatus = {
    runtime: "claude",
    state: "available",
    fetched_at: now().toISOString(),
    quota: { five_hour: {} },
  };
  const options = {
    getCodexStatus: async () => {
      codexCalls += 1;
      return codexStatus;
    },
    getClaudeStatus: async () => {
      claudeCalls += 1;
      return claudeStatus;
    },
    nowMs: () => currentTime,
  };

  assert.deepEqual(await getAgentQuotaStatuses(options), [codexStatus, claudeStatus]);
  assert.deepEqual(await getAgentQuotaStatuses(options), [codexStatus, claudeStatus]);
  assert.deepEqual([codexCalls, claudeCalls], [1, 1]);

  currentTime += 60_001;
  await getAgentQuotaStatuses(options);
  assert.deepEqual([codexCalls, claudeCalls], [2, 1]);

  currentTime += 60 * 60_000;
  await getAgentQuotaStatuses(options);
  assert.deepEqual([codexCalls, claudeCalls], [3, 2]);
});
