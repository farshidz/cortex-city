import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { readConfig, writeConfig } from "@/lib/store";

function getEnvPath(envFile: string): string {
  return path.isAbsolute(envFile)
    ? envFile
    : path.join(process.cwd(), envFile);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  if (!agent.env_file) {
    return NextResponse.json({ vars: {}, path: null });
  }

  const envPath = getEnvPath(agent.env_file);
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // File doesn't exist yet
  }
  return NextResponse.json({ vars, path: agent.env_file });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const config = readConfig();
  const agent = config.agents[id];
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const { vars } = await request.json() as { vars: Record<string, string> };

  // Auto-create env_file path if not set
  const envFile = agent.env_file || `.env.${id}`;
  if (!agent.env_file) {
    config.agents[id] = { ...agent, env_file: envFile };
    await writeConfig(config);
  }

  const envPath = getEnvPath(envFile);
  const dir = path.dirname(envPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Write .env format
  const lines = Object.entries(vars)
    .filter(([k]) => k.trim())
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

  // Explicitly do NOT commit — secrets stay local
  return NextResponse.json({ ok: true, path: envFile });
}
