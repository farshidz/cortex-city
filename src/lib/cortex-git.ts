import { existsSync, statSync, unlinkSync } from "fs";
import { spawn, execFileSync } from "child_process";
import path from "path";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const GIT_DIR = path.join(CORTEX_DIR, ".git");
const INDEX_LOCK = path.join(GIT_DIR, "index.lock");
const STALE_INDEX_LOCK_MS = 5 * 60 * 1000;

export interface CortexGitStatus {
  enabled: boolean;
  pushing: boolean;
  remoteName?: string;
  remoteUrl?: string;
  remoteSlug?: string;
}

function extractRepoSlug(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined;
  const sshMatch = remoteUrl.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remoteUrl.match(/^[a-z]+:\/\/[^/]+\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}

export function getCortexGitStatus(): CortexGitStatus {
  if (!existsSync(GIT_DIR)) {
    return { enabled: false, pushing: false };
  }

  try {
    const remotes = execFileSync("git", ["-C", CORTEX_DIR, "remote"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const remoteName = remotes[0];
    let remoteUrl: string | undefined;
    if (remoteName) {
      try {
        remoteUrl = execFileSync(
          "git",
          ["-C", CORTEX_DIR, "remote", "get-url", remoteName],
          {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }
        ).trim();
      } catch {
        remoteUrl = undefined;
      }
    }

    return {
      enabled: true,
      pushing: remotes.length > 0,
      remoteName,
      remoteUrl,
      remoteSlug: extractRepoSlug(remoteUrl),
    };
  } catch {
    return { enabled: true, pushing: false };
  }
}

export function recoverStaleCortexGitIndexLock(now = Date.now()): boolean {
  try {
    const lock = statSync(INDEX_LOCK);
    if (now - lock.mtimeMs < STALE_INDEX_LOCK_MS) {
      return false;
    }
    unlinkSync(INDEX_LOCK);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return false;
    }
    return false;
  }
}

export function snapshotCortex(reason: string): void {
  if (!existsSync(GIT_DIR)) return;
  recoverStaleCortexGitIndexLock();
  const sanitized = reason.replace(/\s+/g, " ").replace(/"/g, "' ").trim() || "update";
  const script = `cd "${CORTEX_DIR}" && ` +
    `if [ -z "$(git status --porcelain 2>/dev/null)" ]; then exit 0; fi; ` +
    `git add -A >/dev/null 2>&1 && ` +
    `if git diff --cached --quiet 2>/dev/null; then exit 0; fi; ` +
    `git commit -m "Auto snapshot: ${sanitized}" >/dev/null 2>&1 || exit 0; ` +
    `if git remote >/dev/null 2>&1 && [ -n "$(git remote)" ]; then git push >/dev/null 2>&1 || true; fi;`;
  const child = spawn("bash", ["-lc", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
