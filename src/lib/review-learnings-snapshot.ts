import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getCortexPath } from "./store";

// Freeze injected guidance for both experiment groups. Retrospectives continue
// maintaining the live file, which is used again after the experiment is disabled.
export function experimentReviewLearnings(current: string): string {
  const file = getCortexPath("review-reuse-v1-learnings.md");
  try { return readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, current, {mode: 0o600});
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Concurrent first runs all read the same complete winning snapshot.
    return readFileSync(file, "utf8");
  } finally {
    rmSync(temporary, {force: true});
  }
}
