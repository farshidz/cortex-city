import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";

export async function GET() {
  const templatesDir = path.join(process.cwd(), "prompts", "templates");

  function loadTemplate(name: string): string {
    try {
      return readFileSync(path.join(templatesDir, name), "utf-8");
    } catch {
      return "(template not found)";
    }
  }

  return NextResponse.json({
    initial: loadTemplate("initial.md"),
    review: loadTemplate("review.md"),
  });
}
