import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/store";
import type { OrchestratorConfig } from "@/lib/types";

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
