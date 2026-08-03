import { NextRequest, NextResponse } from "next/server";
import { REVIEW_DEBOUNCE_MAX_SECONDS } from "@/lib/review-debounce";
import { readConfig, writeConfig } from "@/lib/store";
import type { OrchestratorConfig } from "@/lib/types";

// Upper bounds the persistence layer enforces, matching the Settings inputs.
const BOUNDED_COUNT_KEYS: Record<string, number> = {
  review_debounce_seconds: REVIEW_DEBOUNCE_MAX_SECONDS,
};

export async function GET() {
  const config = readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as Partial<OrchestratorConfig> &
    Record<string, unknown>;
  const current = readConfig();
  const updated = { ...current, ...body } as OrchestratorConfig &
    Record<string, unknown>;
  const mutableUpdated = updated as Record<string, unknown>;
  const hasOwn = (key: string) =>
    Object.prototype.hasOwnProperty.call(body, key);

  const modelKeys = [
    "default_claude_model",
    "default_codex_model",
    "review_model",
  ] as const;
  for (const key of modelKeys) {
    if (!hasOwn(key)) continue;
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (value) mutableUpdated[key] = value;
    else delete mutableUpdated[key];
  }

  const textKeys = ["review_prompt", "reviewer_agent_prompt"] as const;
  for (const key of textKeys) {
    if (!hasOwn(key)) continue;
    const value = typeof body[key] === "string" ? body[key] : "";
    if (value.trim()) mutableUpdated[key] = value;
    else delete mutableUpdated[key];
  }

  const effortKeys = [
    "default_claude_effort",
    "default_codex_effort",
    "review_effort",
  ] as const;
  for (const key of effortKeys) {
    if (!hasOwn(key)) continue;
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (value) mutableUpdated[key] = value;
    else delete mutableUpdated[key];
  }

  // Bounded settings are enforced here, not only by the Settings input: HTML
  // constraints do not reach this route, and an out-of-range debounce would
  // postpone changed-diff reviews for hours. Invalid input is rejected rather
  // than silently dropped, so a bad write cannot look like a successful clear.
  for (const [key, max] of Object.entries(BOUNDED_COUNT_KEYS)) {
    if (!hasOwn(key)) continue;
    const raw: unknown = body[key];
    if (raw === null || raw === undefined || raw === "") {
      delete mutableUpdated[key];
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max) {
      return NextResponse.json(
        {
          error: `${key} must be an integer between 0 and ${max}`,
        },
        { status: 400 }
      );
    }
    mutableUpdated[key] = raw;
  }

  const currentReviewRuntime =
    current.review_runtime || current.default_agent_runner;
  const updatedReviewRuntime =
    updated.review_runtime || updated.default_agent_runner;
  if (!hasOwn("review_model") && currentReviewRuntime !== updatedReviewRuntime) {
    // A model override is runtime-specific. If a partial API update changes the
    // effective reviewer runtime, do not carry a potentially incompatible model.
    delete updated.review_model;
  }
  if (
    currentReviewRuntime !== updatedReviewRuntime &&
    !hasOwn("review_effort")
  ) {
    delete updated.review_effort;
  }

  await writeConfig(updated);
  return NextResponse.json(updated);
}
