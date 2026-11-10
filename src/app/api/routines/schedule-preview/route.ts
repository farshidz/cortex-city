import { NextRequest, NextResponse } from "next/server";
import { nextRunTimes, validateCron, validateTimezone } from "@/lib/routine-store";

export async function GET(request: NextRequest) {
  const cron = (request.nextUrl.searchParams.get("cron") ?? "").trim().replace(/\s+/g, " ");
  const timezone = (request.nextUrl.searchParams.get("timezone") ?? "UTC").trim() || "UTC";
  const error = validateCron(cron) ?? validateTimezone(timezone);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const next_runs = nextRunTimes(cron, timezone, new Date(), 4).map((date) => date.toISOString());
  return NextResponse.json({ next_runs });
}
