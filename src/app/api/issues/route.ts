import { NextRequest, NextResponse } from "next/server";
import { createIssue, readIssues } from "@/lib/issue-store";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const showResolved = params.get("show_resolved") === "true";
  const page = parsePositiveInt(params.get("page"), 1);
  const requestedPageSize = parsePositiveInt(params.get("page_size"), DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);

  let issues = readIssues();
  if (!showResolved) {
    issues = issues.filter((i) => i.status !== "done" && i.status !== "closed");
  }
  issues.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  const total = issues.length;
  const start = (page - 1) * pageSize;
  const items = issues.slice(start, start + pageSize);
  return NextResponse.json({ items, total, page, page_size: pageSize });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const issue = await createIssue({
    title: body.title,
    description: body.description ?? "",
    plan: body.plan || undefined,
  });
  return NextResponse.json(issue, { status: 201 });
}
