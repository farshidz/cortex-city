import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { snapshotCortex } from "./cortex-git";
import { ensureCortexDir, getCortexPath } from "./store";

let writeLock: Promise<void> = Promise.resolve();
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockDir(): string {
  return `${getLearningsFile()}.lock`;
}

async function acquireFileLock(): Promise<() => void> {
  ensureCortexDir();
  const lockDir = getLockDir();
  const ownerFile = path.join(lockDir, "owner");
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const startedAt = Date.now();

  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(ownerFile, token);
      return () => {
        try {
          if (readFileSync(ownerFile, "utf-8") === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        } catch {}
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for review learnings write lock.");
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = writeLock.then(async () => {
    const release = await acquireFileLock();
    try {
      return await fn();
    } finally {
      release();
    }
  });
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

function writeLearningsFile(content: string): void {
  ensureCortexDir();
  const file = getLearningsFile();
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(temp, content);
  renameSync(temp, file);
  snapshotCortex("review-learnings");
}

export function writeReviewLearnings(content: string): Promise<void> {
  return withWriteLock(() => {
    writeLearningsFile(content);
  });
}

export function compareAndWriteReviewLearnings(
  expectedContent: string,
  nextContent: string
): Promise<boolean> {
  return withWriteLock(() => {
    if (readReviewLearnings() !== expectedContent) {
      return false;
    }
    writeLearningsFile(nextContent);
    return true;
  });
}
