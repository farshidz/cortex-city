import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/store";

export async function GET() {
  const config = readConfig();
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const current = readConfig();
  const updated = { ...current, ...body };
  await writeConfig(updated, "Update config");
  return NextResponse.json(updated);
}
