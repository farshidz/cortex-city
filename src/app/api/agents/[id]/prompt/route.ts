import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { readConfig, autoCommit } from "@/lib/store";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  let content = "";
  if (agent.prompt_file) {
    try {
      content = readFileSync(path.join(process.cwd(), agent.prompt_file), "utf-8");
    } catch {
      content = "";
    }
  }
  return NextResponse.json({ content });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const { content } = await request.json();
  const filePath = agent.prompt_file || `.cortex/prompts/agents/${id}.md`;

  const fullPath = path.join(process.cwd(), filePath);
  const dir = path.dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(fullPath, content, "utf-8");
  autoCommit(`Update prompt for agent: ${agent.name}`, filePath);
  return NextResponse.json({ ok: true, path: filePath });
}
