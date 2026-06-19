import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir, getCortexPath } from "./store";

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.then(() => {}, () => {});
  return result;
}

function getLearningsFile(): string {
  return getCortexPath("review-learnings.md");
}

export function readReviewLearnings(): string {
  ensureCortexDir();
  const file = getLearningsFile();
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

export function writeReviewLearnings(content: string): Promise<void> {
  return withWriteLock(() => {
    ensureCortexDir();
    const file = getLearningsFile();
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
    );
    writeFileSync(temp, content);
    renameSync(temp, file);
    snapshotCortex("review-learnings");
  });
}
