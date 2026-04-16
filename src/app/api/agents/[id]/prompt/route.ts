import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { readConfig } from "@/lib/store";
import { snapshotCortex } from "@/lib/cortex-git";
import { resolvePromptPath, relativeFromCwd } from "@/lib/agent-files";
import type { PromptMode } from "@/lib/types";

function resolveMode(request: NextRequest): PromptMode {
  const mode = request.nextUrl.searchParams.get("mode");
  if (mode === "review" || mode === "cleanup") {
    return mode;
  }
  return "initial";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const mode = resolveMode(request);

  let content = "";
  const fullPath = resolvePromptPath(agent, id, mode);
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    content = "";
  }
  return NextResponse.json({ content, path: relativeFromCwd(fullPath), mode });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const mode = resolveMode(request);

  const { content } = await request.json();
  const fullPath = resolvePromptPath(agent, id, mode);
  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(fullPath, content, "utf-8");
  snapshotCortex(`prompt:${id}:${mode}`);
  return NextResponse.json({ ok: true, path: relativeFromCwd(fullPath), mode });
}
