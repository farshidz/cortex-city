import test from "node:test";
import assert from "node:assert/strict";
import { codexWeeklyUsedPercent, enforceReviewQuota, ReviewQuotaDeferredError } from "./review-quota";
import type { AgentQuotaStatus } from "./types";

function quota(rate_limits: unknown): AgentQuotaStatus {
  return { runtime: "codex", state: "available", fetched_at: new Date().toISOString(), quota: { rate_limits } };
}
const weekly = (usedPercent: number) => ({ usedPercent, windowDurationMins: 10080 });

test("weekly usage selects the main account bucket and either weekly slot", () => {
  assert.equal(codexWeeklyUsedPercent(quota({ codex: { primary: weekly(8), secondary: null }, codex_bengalfox: { secondary: weekly(99) } })), 8);
  assert.equal(codexWeeklyUsedPercent(quota({ codex: { primary: { usedPercent: 99, windowDurationMins: 300 }, secondary: weekly(20) } })), 20);
  assert.equal(codexWeeklyUsedPercent(quota({ limitId: "codex", primary: weekly(21) })), 21);
  assert.equal(codexWeeklyUsedPercent(quota({ primary: weekly(0) })), 0);
  for (const limits of [{}, { codex_bengalfox: { primary: weekly(99) } }, { limitId: "codex_bengalfox", primary: weekly(99) }, { codex: { primary: weekly(NaN) } }, { codex: { primary: weekly(-1) } }, { codex: { primary: { usedPercent: 40, windowDurationMins: 300 } } }]) {
    assert.equal(codexWeeklyUsedPercent(quota(limits)), undefined);
  }
  assert.equal(codexWeeklyUsedPercent({ ...quota({ primary: weekly(90) }), state: "error" }), undefined);
});

test("an unset limit bypasses quota and author reads regardless of exemptions", async () => {
  const deps = {
    readQuota: async (): Promise<AgentQuotaStatus> => { throw new Error("Unexpected quota read"); },
    getPRUserLogin: async (): Promise<string> => { throw new Error("Unexpected author lookup"); },
    postReviewQuotaRefusal: async () => { assert.fail("Unexpected refusal"); },
  };
  for (const whitelist of [undefined, [], ["octocat"]]) {
    await enforceReviewQuota({ review_author_whitelist: whitelist }, { author: "", pr_url: "url" }, deps);
  }
});

test("configured limits exempt case-insensitive listed authors without reading quota", async () => {
  const deps = {
    readQuota: async (): Promise<AgentQuotaStatus> => { throw new Error("Unexpected quota read"); },
    getPRUserLogin: async () => "OCTOCAT",
    postReviewQuotaRefusal: async () => { assert.fail("Unexpected refusal"); },
  };
  const config = { review_author_whitelist: [" Octocat "], review_weekly_usage_limit_percent: 0 };
  await enforceReviewQuota(config, { author: "octocat", pr_url: "url" }, deps);
  await enforceReviewQuota(config, { author: "", pr_url: "url" }, deps);
});

test("empty exemption lists apply the configured limit to everyone without author lookup", async () => {
  let usage = 19;
  let refusals = 0;
  const deps = {
    readQuota: async () => quota({ primary: weekly(usage) }),
    getPRUserLogin: async (): Promise<string> => { throw new Error("Unexpected author lookup"); },
    postReviewQuotaRefusal: async () => { refusals++; },
  };
  for (const whitelist of [undefined, [], ["  "]]) {
    const config = { review_author_whitelist: whitelist, review_weekly_usage_limit_percent: 20 };
    const request = { author: "", pr_url: "url" };
    usage = 19;
    await enforceReviewQuota(config, request, deps);
    usage = 20;
    await assert.rejects(enforceReviewQuota(config, request, deps), ReviewQuotaDeferredError);
  }
  assert.equal(refusals, 3);
});

test("quota gate refuses at inclusive configured boundaries and permits recovery", async () => {
  let usage = 19;
  const comments: string[] = [];
  const deps = {
    readQuota: async () => quota({ codex: { primary: weekly(usage) } }),
    getPRUserLogin: async () => "outsider",
    postReviewQuotaRefusal: async (url: string) => { comments.push(url); },
  };
  const config = { review_author_whitelist: ["octocat"], review_weekly_usage_limit_percent: 20 };
  const request = { author: "outsider", pr_url: "url" };
  await enforceReviewQuota(config, request, deps);
  usage = 20;
  await assert.rejects(enforceReviewQuota(config, request, deps), ReviewQuotaDeferredError);
  await enforceReviewQuota({ ...config, review_weekly_usage_limit_percent: 21 }, request, deps);
  usage = 0;
  await assert.rejects(enforceReviewQuota({ ...config, review_weekly_usage_limit_percent: 0 }, request, deps), ReviewQuotaDeferredError);
  await enforceReviewQuota(config, request, deps);
  usage = 100;
  await assert.rejects(enforceReviewQuota({ ...config, review_weekly_usage_limit_percent: 100 }, request, deps), ReviewQuotaDeferredError);
  assert.deepEqual(comments, ["url", "url", "url"]);
});

test("unknown usage or author defers without posting a false refusal; delivery failures propagate", async () => {
  const config = { review_author_whitelist: ["octocat"], review_weekly_usage_limit_percent: 20 };
  const request = { author: "outsider", pr_url: "url" };
  const deps = {
    readQuota: async () => quota({}),
    getPRUserLogin: async () => "",
    postReviewQuotaRefusal: async () => { assert.fail("Unexpected refusal"); },
  };
  await assert.rejects(enforceReviewQuota(config, request, deps), /usage is unavailable/);
  await assert.rejects(enforceReviewQuota(config, { ...request, author: "" }, deps), /author is unavailable/);
  await assert.rejects(enforceReviewQuota(config, request, { ...deps, readQuota: async () => quota({ primary: weekly(20) }), postReviewQuotaRefusal: async () => { throw new Error("GitHub unavailable"); } }), /GitHub unavailable/);
});

test("invalid stored limits defer instead of substituting a hidden default", async () => {
  for (const value of [NaN, Infinity, -1, 101, 20.5]) {
    await assert.rejects(enforceReviewQuota({ review_weekly_usage_limit_percent: value }, { author: "", pr_url: "url" }), /must be an integer between 0 and 100/);
  }
});
