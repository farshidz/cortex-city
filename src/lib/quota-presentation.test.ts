import test from "node:test";
import assert from "node:assert/strict";
import {
  formatExpiry,
  formatResetTime,
  presentQuota,
  severityForPercent,
  toEpochMs,
  windowLabel,
} from "./quota-presentation";

const NOW = Date.parse("2026-07-16T02:00:00.000Z");

test("toEpochMs normalizes seconds, milliseconds, and ISO strings", () => {
  assert.equal(toEpochMs(1_784_780_584), 1_784_780_584_000);
  assert.equal(toEpochMs(1_784_780_584_000), 1_784_780_584_000);
  assert.equal(toEpochMs("2026-07-16T05:00:00Z"), Date.parse("2026-07-16T05:00:00Z"));
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs("not-a-date"), null);
});

test("severityForPercent escalates with usage", () => {
  assert.equal(severityForPercent(null), "normal");
  assert.equal(severityForPercent(10), "normal");
  assert.equal(severityForPercent(85), "warning");
  assert.equal(severityForPercent(97), "critical");
});

test("windowLabel names known windows and derives the rest", () => {
  assert.equal(windowLabel(300), "5-hour");
  assert.equal(windowLabel(10080), "Weekly");
  assert.equal(windowLabel(1440), "Daily");
  assert.equal(windowLabel(120), "2-hour");
  assert.equal(windowLabel(2880), "2-day");
});

test("formatResetTime switches from relative to absolute past a day", () => {
  assert.equal(formatResetTime(null, NOW), null);
  assert.equal(formatResetTime(NOW - 1000, NOW), "Resets soon");
  assert.equal(formatResetTime(NOW + 60 * 60_000 + 5 * 60_000, NOW), "Resets in 1h 5m");
  assert.equal(formatResetTime(NOW + 15 * 60_000, NOW), "Resets in 15m");
  assert.match(formatResetTime(NOW + 2 * 86_400_000, NOW) || "", /^Resets /);
});

test("formatExpiry renders a date or a no-expiry fallback", () => {
  assert.equal(formatExpiry(null), "No expiry");
  assert.match(formatExpiry(Date.parse("2026-07-20T00:00:00Z")), /^Expires /);
});

test("presentQuota returns an empty view when no quota is present", () => {
  const view = presentQuota("codex", undefined);
  assert.equal(view.empty, true);
  assert.deepEqual(view.sections, []);
  assert.equal(view.resetCredits, null);
});

test("Codex quota keys windows by duration and lists available resets", () => {
  const view = presentQuota("codex", {
    rate_limits: {
      codex: {
        limitId: "codex",
        limitName: null,
        planType: "pro",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_784_780_584 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_785_000_000 },
      },
      codex_spark: {
        limitId: "codex_spark",
        limitName: "GPT-5.3-Codex-Spark",
        planType: "pro",
        primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1_785_100_000 },
        secondary: null,
      },
    },
    rate_limit_reset_credits: {
      availableCount: 2,
      credits: [
        {
          id: "credit-late",
          title: "Full reset",
          status: "available",
          expiresAt: 1_786_555_640,
        },
        {
          id: "credit-early",
          title: "Full reset",
          status: "available",
          expiresAt: 1_784_334_521,
        },
        { id: "credit-used", title: "Full reset", status: "consumed", expiresAt: 1 },
      ],
    },
  });

  assert.equal(view.planLabel, "Pro");
  assert.equal(view.sections.length, 1);
  const bars = view.sections[0].bars;
  // 5-hour window comes first, then the two weekly windows (default before named).
  assert.deepEqual(
    bars.map((bar) => bar.label),
    ["5-hour limit", "Weekly limit", "GPT-5.3-Codex-Spark"]
  );
  assert.equal(bars[2].sublabel, "Weekly");
  assert.equal(bars[1].severity, "normal");

  assert.ok(view.resetCredits);
  assert.equal(view.resetCredits?.availableCount, 2);
  // Consumed credit is filtered out; remaining ones are sorted by soonest expiry.
  assert.deepEqual(
    view.resetCredits?.credits.map((credit) => credit.key),
    ["credit-early", "credit-late"]
  );
});

test("Codex quota supports a single weekly window when the 5-hour limit is absent", () => {
  const view = presentQuota("codex", {
    rate_limits: {
      codex: {
        limitName: null,
        primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1_784_780_584 },
        secondary: null,
      },
    },
  });
  assert.equal(view.sections[0].bars.length, 1);
  assert.equal(view.sections[0].bars[0].label, "Weekly limit");
});

test("Codex quota normalizes a single-bucket rateLimits snapshot", () => {
  const view = presentQuota("codex", {
    rate_limits: {
      limitId: "codex",
      limitName: null,
      planType: "pro",
      primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_784_780_584 },
      secondary: null,
    },
  });
  assert.equal(view.empty, false);
  assert.equal(view.sections[0].bars.length, 1);
  assert.equal(view.sections[0].bars[0].label, "Weekly limit");
  assert.equal(view.sections[0].bars[0].usedPercent, 30);
});

test("Codex reset credits keep an authoritative count when details are missing", () => {
  const view = presentQuota("codex", {
    rate_limit_reset_credits: { availableCount: 2, credits: null },
  });
  assert.ok(view.resetCredits);
  assert.equal(view.resetCredits?.availableCount, 2);
  assert.deepEqual(view.resetCredits?.credits, []);
});

test("Claude scoped weekly limits receive unique keys", () => {
  const view = presentQuota("claude", {
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 10,
        resets_at: "2026-07-20T00:59:59Z",
        scope: { model: { display_name: "Fable" } },
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 20,
        resets_at: "2026-07-20T00:59:59Z",
        scope: { model: { display_name: "Opus" } },
        is_active: true,
      },
    ],
  });
  const keys = view.sections[0].bars.map((bar) => bar.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    view.sections[0].bars.map((bar) => bar.label),
    ["Fable", "Opus"]
  );
});

test("Claude quota maps the limits array to session and weekly sections", () => {
  const view = presentQuota("claude", {
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 3,
        severity: "normal",
        resets_at: "2026-07-16T09:29:59Z",
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resets_at: "2026-07-20T00:59:59Z",
        is_active: false,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resets_at: null,
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: false,
      },
    ],
    account: { subscription_type: "team", rate_limit_tier: "default_claude_max_5x" },
  });

  assert.equal(view.planLabel, "Team");
  assert.equal(view.sections.length, 2);
  assert.equal(view.sections[0].title, "");
  assert.deepEqual(
    view.sections[0].bars.map((bar) => bar.label),
    ["Current session"]
  );
  assert.equal(view.sections[0].bars[0].usedPercent, 3);

  assert.equal(view.sections[1].title, "Weekly limits");
  const weekly = view.sections[1].bars;
  assert.deepEqual(weekly.map((bar) => bar.label), ["All models", "Fable"]);
  // Never-used scoped limit is surfaced as a note rather than a 0% bar.
  assert.equal(weekly[1].usedPercent, null);
  assert.equal(weekly[1].note, "Not used yet");
});

test("Claude quota falls back to legacy five_hour and seven_day fields", () => {
  const view = presentQuota("claude", {
    five_hour: { utilization: 40, resets_at: "2026-07-16T05:00:00Z" },
    seven_day: { utilization: 60, resets_at: "2026-07-20T00:00:00Z" },
  });
  assert.equal(view.sections.length, 2);
  assert.equal(view.sections[0].bars[0].label, "Current session");
  assert.equal(view.sections[0].bars[0].usedPercent, 40);
  assert.equal(view.sections[1].bars[0].label, "All models");
  assert.equal(view.sections[1].bars[0].usedPercent, 60);
});
