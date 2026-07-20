import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const sessionHelper = path.join(
  repoRoot,
  "scripts",
  "cortex-runtime-session-hygiene.mjs"
);
const hygieneScript = path.join(repoRoot, "scripts", "cortex-disk-hygiene.sh");

function oldDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

function writeRollout(
  sessionsRoot: string,
  sessionId: string,
  cwd: string,
  ageDays: number
): string {
  const dir = path.join(sessionsRoot, "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-test-${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`
  );
  const timestamp = oldDate(ageDays);
  utimesSync(file, timestamp, timestamp);
  return file;
}

test("runtime session hygiene protects live stores and conservatively prunes old Cortex rollouts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cortex-session-hygiene-"));
  try {
    const appDir = path.join(root, "app");
    const homeDir = path.join(root, "home");
    const sessionsRoot = path.join(homeDir, ".codex", "sessions");
    const cortexDir = path.join(appDir, ".cortex");
    const fakeBin = path.join(root, "bin");
    mkdirSync(cortexDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const activeTaskId = "00000000-0000-4000-8000-000000000001";
    const activeReviewId = "00000000-0000-4000-8000-000000000002";
    const finalReviewId = "00000000-0000-4000-8000-000000000003";
    const orphanCortexId = "00000000-0000-4000-8000-000000000004";
    const unrelatedId = "00000000-0000-4000-8000-000000000005";
    const recentId = "00000000-0000-4000-8000-000000000006";
    const openId = "00000000-0000-4000-8000-000000000007";

    writeFileSync(
      path.join(cortexDir, "tasks.json"),
      JSON.stringify([{ status: "in_review", session_id: activeTaskId }])
    );
    writeFileSync(
      path.join(cortexDir, "reviews.json"),
      JSON.stringify({
        active: { session_id: activeReviewId },
        final: {
          session_id: finalReviewId,
          final_at: "2026-01-01T00:00:00.000Z",
        },
        open: {
          session_id: openId,
          final_at: "2026-01-01T00:00:00.000Z",
        },
        recent: {
          session_id: recentId,
          final_at: "2026-01-01T00:00:00.000Z",
        },
      })
    );

    const activeTask = writeRollout(sessionsRoot, activeTaskId, appDir, 45);
    const activeReview = writeRollout(sessionsRoot, activeReviewId, appDir, 45);
    const finalReview = writeRollout(sessionsRoot, finalReviewId, appDir, 45);
    const orphanCortex = writeRollout(sessionsRoot, orphanCortexId, appDir, 45);
    const unrelated = writeRollout(
      sessionsRoot,
      unrelatedId,
      path.join(root, "unrelated"),
      45
    );
    const recent = writeRollout(sessionsRoot, recentId, appDir, 2);
    const open = writeRollout(sessionsRoot, openId, appDir, 45);
    const emptyDateDir = path.join(sessionsRoot, "2020", "01", "01");
    mkdirSync(emptyDateDir, { recursive: true });

    const fakeLsof = path.join(fakeBin, "lsof");
    writeFileSync(
      fakeLsof,
      `#!/usr/bin/env bash\n[[ "$*" == *"${openId}"* ]] && exit 0\nexit 1\n`
    );
    chmodSync(fakeLsof, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const args = [
      sessionHelper,
      "--app-dir",
      appDir,
      "--home",
      homeDir,
      "--retention-days",
      "30",
    ];

    const dryRun = execFileSync(process.execPath, args, {
      env,
      encoding: "utf8",
    });
    assert.match(dryRun, /would_delete=2/);
    assert.ok(existsSync(finalReview));
    assert.ok(existsSync(orphanCortex));

    const applied = execFileSync(process.execPath, [...args, "--apply"], {
      env,
      encoding: "utf8",
    });
    assert.match(applied, /deleted=2/);
    assert.ok(existsSync(activeTask));
    assert.ok(existsSync(activeReview));
    assert.ok(existsSync(unrelated));
    assert.ok(existsSync(recent));
    assert.ok(existsSync(open));
    assert.equal(existsSync(finalReview), false);
    assert.equal(existsSync(orphanCortex), false);
    assert.equal(existsSync(emptyDateDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime session hygiene refuses deletion when Cortex state is malformed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cortex-session-state-"));
  try {
    const appDir = path.join(root, "app");
    const homeDir = path.join(root, "home");
    const sessionsRoot = path.join(homeDir, ".codex", "sessions");
    const cortexDir = path.join(appDir, ".cortex");
    mkdirSync(cortexDir, { recursive: true });
    writeFileSync(path.join(cortexDir, "tasks.json"), "not-json");
    const rollout = writeRollout(
      sessionsRoot,
      "00000000-0000-4000-8000-000000000008",
      appDir,
      45
    );

    const result = spawnSync(
      process.execPath,
      [
        sessionHelper,
        "--apply",
        "--app-dir",
        appDir,
        "--home",
        homeDir,
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to prune sessions/);
    assert.ok(existsSync(rollout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime session hygiene retains eligible rollouts when lsof is unavailable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cortex-session-lsof-"));
  try {
    const appDir = path.join(root, "app");
    const homeDir = path.join(root, "home");
    const cortexDir = path.join(appDir, ".cortex");
    const emptyPath = path.join(root, "empty-path");
    mkdirSync(cortexDir, { recursive: true });
    mkdirSync(emptyPath);
    writeFileSync(path.join(cortexDir, "tasks.json"), "[]");
    writeFileSync(path.join(cortexDir, "reviews.json"), "{}");
    const rollout = writeRollout(
      path.join(homeDir, ".codex", "sessions"),
      "00000000-0000-4000-8000-000000000009",
      appDir,
      45
    );

    const result = spawnSync(
      process.execPath,
      [
        sessionHelper,
        "--apply",
        "--app-dir",
        appDir,
        "--home",
        homeDir,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: emptyPath } }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /lsof is unavailable; session deletion is disabled/);
    assert.ok(existsSync(rollout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disk hygiene continues after a deletion failure and reports failure at the end", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cortex-disk-hygiene-"));
  try {
    const appDir = path.join(root, "app");
    const homeDir = path.join(root, "home");
    const logDir = path.join(appDir, "logs");
    const tmpDir = path.join(appDir, "tmp");
    const scriptsDir = path.join(appDir, "scripts");
    const fakeBin = path.join(root, "bin");
    mkdirSync(logDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    symlinkSync(sessionHelper, path.join(scriptsDir, path.basename(sessionHelper)));

    const failedLog = path.join(logDir, "server-old.log");
    writeFileSync(failedLog, "old log");
    utimesSync(failedLog, oldDate(30), oldDate(30));
    const reviewRoot = path.join(tmpDir, "reviews");
    const reviewWorkspace = path.join(reviewRoot, "review-run-orphan");
    mkdirSync(reviewWorkspace, { recursive: true });
    const marker = path.join(
      reviewWorkspace,
      ".cortex-city-review-workspace.json"
    );
    writeFileSync(
      marker,
      JSON.stringify({
        owner: "cortex-city",
        purpose: "review-runtime",
        runtime_pid: 999_999_999,
      })
    );
    writeFileSync(path.join(reviewWorkspace, "artifact"), "scratch");
    utimesSync(path.join(reviewWorkspace, "artifact"), oldDate(1), oldDate(1));
    utimesSync(marker, oldDate(1), oldDate(1));
    utimesSync(reviewWorkspace, oldDate(1), oldDate(1));

    const unmarkedWorkspace = path.join(reviewRoot, "review-run-unmarked");
    mkdirSync(unmarkedWorkspace);
    utimesSync(unmarkedWorkspace, oldDate(1), oldDate(1));
    const liveWorkspace = path.join(reviewRoot, "review-run-live");
    mkdirSync(liveWorkspace);
    const liveMarker = path.join(
      liveWorkspace,
      ".cortex-city-review-workspace.json"
    );
    writeFileSync(
      liveMarker,
      JSON.stringify({
        owner: "cortex-city",
        purpose: "review-runtime",
        runtime_pid: process.pid,
      })
    );
    utimesSync(liveMarker, oldDate(1), oldDate(1));
    utimesSync(liveWorkspace, oldDate(1), oldDate(1));
    utimesSync(reviewRoot, oldDate(1), oldDate(1));

    const realRm = execFileSync("sh", ["-c", "command -v rm"], {
      encoding: "utf8",
    }).trim();
    const fakeRm = path.join(fakeBin, "rm");
    writeFileSync(
      fakeRm,
      `#!/usr/bin/env bash\nif [[ "$*" == *"server-old.log"* ]]; then exit 1; fi\nexec "${realRm}" "$@"\n`
    );
    chmodSync(fakeRm, 0o755);
    const fakeLsof = path.join(fakeBin, "lsof");
    writeFileSync(fakeLsof, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(fakeLsof, 0o755);

    const result = spawnSync(
      "bash",
      [
        hygieneScript,
        "--apply",
        "--app-dir",
        appDir,
        "--home",
        homeDir,
        "--log-dir",
        logDir,
        "--tmp-dir",
        tmpDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CORTEX_DISK_HYGIENE_LOCK_FILE: path.join(root, "hygiene.lock"),
          CORTEX_NPM_CACHE_ACTION: "skip",
          CORTEX_PNPM_STORE_ACTION: "skip",
          CORTEX_PRUNE_OWNED_TMP_ALL: "1",
          CORTEX_TMP_SCAN_DIRS: tmpDir,
          CORTEX_REVIEW_WORKSPACE_ROOT: reviewRoot,
          CORTEX_REVIEW_WORKSPACE_RETENTION_HOURS: "6",
          CORTEX_CODEX_SESSIONS_DIR: path.join(homeDir, ".codex", "sessions"),
        },
      }
    );

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(existsSync(failedLog));
    assert.equal(existsSync(reviewWorkspace), false);
    assert.ok(existsSync(reviewRoot));
    assert.ok(existsSync(unmarkedWorkspace));
    assert.ok(existsSync(liveWorkspace));
    assert.match(result.stderr, /failed to delete .*server-old\.log/);
    assert.match(result.stdout, /Cortex disk hygiene complete failures=1/);
    assert.match(result.stdout, /skipping unmarked review workspace/);
    assert.match(result.stdout, /skipping live review workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disk hygiene systemd timer runs the apply service hourly", () => {
  const timer = readFileSync(
    path.join(repoRoot, "deploy/systemd/cortex-city-disk-hygiene.timer"),
    "utf8"
  );
  const service = readFileSync(
    path.join(repoRoot, "deploy/systemd/cortex-city-disk-hygiene.service"),
    "utf8"
  );
  assert.match(timer, /^OnCalendar=hourly$/m);
  assert.match(timer, /^RandomizedDelaySec=10m$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(service, /cortex-disk-hygiene\.sh --apply/);
});
