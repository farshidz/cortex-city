import { NextRequest, NextResponse } from "next/server";
import {
  readReviewLearnings,
  writeReviewLearnings,
} from "@/lib/review-learnings-store";
import { readConfig } from "@/lib/store";

export async function GET() {
  const config = readConfig();
  return NextResponse.json({
    content: readReviewLearnings(),
    enabled: config.review_learning_enabled !== false,
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const content = typeof body?.content === "string" ? body.content : "";
  await writeReviewLearnings(content);
  const config = readConfig();
  return NextResponse.json({
    content,
    enabled: config.review_learning_enabled !== false,
  });
}
