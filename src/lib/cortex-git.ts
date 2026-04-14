import { existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";

const CORTEX_DIR = path.join(process.cwd(), ".cortex");
const GIT_DIR = path.join(CORTEX_DIR, ".git");

export function snapshotCortex(reason: string): void {
  if (!existsSync(GIT_DIR)) return;
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
