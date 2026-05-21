import { NextRequest, NextResponse } from "next/server";
import { addComment } from "@/lib/issue-store";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  try {
    const comment = await addComment(id, body.body);
    return NextResponse.json(comment, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
