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

test("quota gate exempts empty lists and case-insensitive whitelisted authors without reading quota", async () => {
  let reads = 0;
  const deps = {
    readQuota: async () => { reads++; return quota({ primary: weekly(100) }); },
    getPRUserLogin: async () => "OCTOCAT",
    postReviewQuotaRefusal: async () => { assert.fail("Unexpected refusal"); },
  };
  for (const whitelist of [undefined, [], ["  "], [" Octocat "]]) {
    await enforceReviewQuota({ review_author_whitelist: whitelist }, { author: "octocat", pr_url: "url" }, deps);
  }
  await enforceReviewQuota({ review_author_whitelist: ["octocat"] }, { author: "", pr_url: "url" }, deps);
  assert.equal(reads, 0);
});

test("quota gate refuses at inclusive default/configured boundaries and permits recovery", async () => {
  let usage = 19;
  const comments: string[] = [];
  const deps = {
    readQuota: async () => quota({ codex: { primary: weekly(usage) } }),
    getPRUserLogin: async () => "outsider",
    postReviewQuotaRefusal: async (url: string) => { comments.push(url); },
  };
  const config = { review_author_whitelist: ["octocat"] };
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
  const config = { review_author_whitelist: ["octocat"] };
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
