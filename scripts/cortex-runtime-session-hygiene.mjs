#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const UUID_AT_END =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const METADATA_READ_LIMIT = 256 * 1024;

function usage() {
  process.stdout.write(`Usage: scripts/cortex-runtime-session-hygiene.mjs [options]

Prune old Cortex-owned Codex rollout files. Dry-run is the default.

Options:
  --apply                 Delete eligible rollout files.
  --dry-run               Print eligible rollout files without deleting them.
  --app-dir DIR           Cortex City app directory.
  --home DIR              Service-user home directory.
  --sessions-dir DIR      Codex sessions directory. Default: HOME/.codex/sessions.
  --retention-days N      Minimum rollout age. Default: 30.
  --review-workspace-root DIR
                          Managed review workspace root. Default: APP_DIR/tmp.
  -h, --help              Show this help.
`);
}

function positiveInteger(label, value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${value}`);
  }
  return Number(value);
}

function parseArgs(argv, env = process.env) {
  const options = {
    apply: false,
    appDir: env.CORTEX_APP_DIR || process.cwd(),
    homeDir: env.CORTEX_HOME_DIR || env.HOME || "/home/cortex",
    sessionsDir: env.CORTEX_CODEX_SESSIONS_DIR || "",
    retentionDays: env.CORTEX_CODEX_SESSION_RETENTION_DAYS || "30",
    reviewWorkspaceRoot: env.CORTEX_REVIEW_WORKSPACE_ROOT || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || !argv[index]) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--app-dir") options.appDir = value();
    else if (arg === "--home") options.homeDir = value();
    else if (arg === "--sessions-dir") options.sessionsDir = value();
    else if (arg === "--retention-days") options.retentionDays = value();
    else if (arg === "--review-workspace-root") {
      options.reviewWorkspaceRoot = value();
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.appDir = path.resolve(options.appDir);
  options.homeDir = path.resolve(options.homeDir);
  options.sessionsDir = path.resolve(
    options.sessionsDir || path.join(options.homeDir, ".codex", "sessions")
  );
  options.reviewWorkspaceRoot = path.resolve(
    options.reviewWorkspaceRoot || path.join(options.appDir, "tmp", "reviews")
  );
  if (options.sessionsDir === path.parse(options.sessionsDir).root) {
    throw new Error(`Refusing unsafe sessions directory: ${options.sessionsDir}`);
  }
  options.retentionDays = positiveInteger(
    "CORTEX_CODEX_SESSION_RETENTION_DAYS",
    options.retentionDays
  );
  return options;
}

function readJsonStore(file, emptyValue) {
  if (!existsSync(file)) return emptyValue;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to prune sessions because ${file} could not be read: ${error.message}`
    );
  }
  return parsed;
}

function addSessionId(target, value) {
  if (typeof value === "string" && value.trim()) target.add(value.trim());
}

function taskIsActive(task) {
  return (
    ["open", "in_progress", "in_review"].includes(task?.status) ||
    Number.isInteger(task?.current_run_pid)
  );
}

function reviewIsActive(review) {
  return (
    !review?.final_at ||
    Number.isInteger(review?.current_run_pid) ||
    Number.isInteger(review?.retro_run_pid)
  );
}

function collectSessionReferences(appDir) {
  const cortexDir = path.join(appDir, ".cortex");
  const tasks = readJsonStore(path.join(cortexDir, "tasks.json"), []);
  const reviewMap = readJsonStore(path.join(cortexDir, "reviews.json"), {});
  if (!Array.isArray(tasks)) {
    throw new Error("Refusing to prune sessions because tasks.json is not an array");
  }
  if (!reviewMap || typeof reviewMap !== "object" || Array.isArray(reviewMap)) {
    throw new Error("Refusing to prune sessions because reviews.json is not an object");
  }

  const protectedIds = new Set();
  const knownCortexIds = new Set();
  const addTaskIds = (target, task) => {
    addSessionId(target, task?.session_id);
    addSessionId(target, task?.codex_usage_session_id);
    // These legacy fields may still exist in a store from an older release.
    addSessionId(target, task?.reviewer_session_id);
    addSessionId(target, task?.reviewer_codex_usage_session_id);
  };
  const addReviewIds = (target, review) => {
    addSessionId(target, review?.session_id);
    if (Array.isArray(review?.followups)) {
      for (const followup of review.followups) {
        addSessionId(target, followup?.session_id);
      }
    }
  };

  for (const task of tasks) {
    addTaskIds(knownCortexIds, task);
    if (taskIsActive(task)) addTaskIds(protectedIds, task);
  }
  for (const review of Object.values(reviewMap)) {
    addReviewIds(knownCortexIds, review);
    if (reviewIsActive(review)) addReviewIds(protectedIds, review);
  }

  return { protectedIds, knownCortexIds };
}

function readSessionMetadata(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(METADATA_READ_LIMIT);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    for (const line of lines.slice(0, 32)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== "session_meta" || !event.payload) continue;
      return {
        id: typeof event.payload.id === "string" ? event.payload.id : undefined,
        cwd:
          typeof event.payload.cwd === "string" ? event.payload.cwd : undefined,
      };
    }
  } finally {
    closeSync(fd);
  }
  return {};
}

function pathIsWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function metadataBelongsToCortex(metadata, options) {
  if (!metadata.cwd) return false;
  const cwd = path.resolve(metadata.cwd);
  if (cwd === options.appDir) return true;
  if (pathIsWithin(path.join(options.appDir, ".cortex", "repos"), cwd)) {
    return true;
  }
  if (pathIsWithin(options.reviewWorkspaceRoot, cwd)) {
    const relative = path.relative(options.reviewWorkspaceRoot, cwd);
    return relative.split(path.sep).some((segment) => segment.startsWith("review-run-"));
  }
  return false;
}

function listRollouts(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

function lsofAvailable() {
  const result = spawnSync("lsof", ["-v"], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return !result.error;
}

function fileOpenStatus(file) {
  const result = spawnSync("lsof", ["--", file], {
    stdio: "ignore",
    timeout: 10_000,
  });
  if (result.error || result.signal || result.status === null) return "unknown";
  return result.status === 0 ? "open" : "closed";
}

function removeEmptyDirectories(root, apply) {
  let count = 0;
  let failures = 0;
  if (!existsSync(root)) return { count, failures };
  const visit = (dir) => {
    let logicallyEmpty = true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!visit(path.join(dir, entry.name))) logicallyEmpty = false;
      } else {
        logicallyEmpty = false;
      }
    }
    if (dir === root || !logicallyEmpty) return logicallyEmpty;
    count += 1;
    if (!apply) {
      process.stdout.write(`would remove empty session directory ${dir}\n`);
      return true;
    }
    try {
      rmdirSync(dir);
      return true;
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `warning: failed to remove empty session directory ${dir}: ${error.message}\n`
      );
      return false;
    }
  };
  visit(root);
  return { count, failures };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function pruneRuntimeSessions(options, now = Date.now()) {
  const references = collectSessionReferences(options.appDir);
  const rollouts = listRollouts(options.sessionsDir);
  const oldestAllowed = now - options.retentionDays * 24 * 60 * 60 * 1000;
  const checkOpenFiles = lsofAvailable();
  let candidates = 0;
  let protectedCount = 0;
  let unknownOwnership = 0;
  let openCount = 0;
  let deleted = 0;
  let deletedBytes = 0;
  let failures = 0;

  if (!checkOpenFiles) {
    process.stderr.write(
      "warning: lsof is unavailable; session deletion is disabled so open rollouts cannot be verified\n"
    );
  }

  for (const file of rollouts) {
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      failures += 1;
      process.stderr.write(`warning: cannot stat session ${file}: ${error.message}\n`);
      continue;
    }
    if (stat.mtimeMs >= oldestAllowed) continue;
    candidates += 1;

    let metadata = {};
    try {
      metadata = readSessionMetadata(file);
    } catch (error) {
      process.stderr.write(`warning: cannot inspect session ${file}: ${error.message}\n`);
    }
    const filenameId = path.basename(file).match(UUID_AT_END)?.[1];
    const sessionIds = new Set([metadata.id, filenameId].filter(Boolean));
    if ([...sessionIds].some((id) => references.protectedIds.has(id))) {
      protectedCount += 1;
      continue;
    }

    const knownCortexSession = [...sessionIds].some((id) =>
      references.knownCortexIds.has(id)
    );
    if (!knownCortexSession && !metadataBelongsToCortex(metadata, options)) {
      unknownOwnership += 1;
      continue;
    }

    if (checkOpenFiles) {
      const openStatus = fileOpenStatus(file);
      if (openStatus !== "closed") {
        openCount += 1;
        if (openStatus === "unknown") {
          process.stderr.write(
            `warning: could not verify whether session is open; skipping ${file}\n`
          );
        }
        continue;
      }
    }
    if (!checkOpenFiles) continue;

    if (!options.apply) {
      process.stdout.write(`would delete Codex session ${file} (${stat.size} bytes)\n`);
      deleted += 1;
      deletedBytes += stat.size;
      continue;
    }
    try {
      unlinkSync(file);
      process.stdout.write(`deleted Codex session ${file} (${stat.size} bytes)\n`);
      deleted += 1;
      deletedBytes += stat.size;
    } catch (error) {
      failures += 1;
      process.stderr.write(`warning: failed to delete session ${file}: ${error.message}\n`);
    }
  }

  let emptyDirectories = 0;
  try {
    const emptyResult = removeEmptyDirectories(options.sessionsDir, options.apply);
    emptyDirectories = emptyResult.count;
    failures += emptyResult.failures;
  } catch (error) {
    failures += 1;
    process.stderr.write(`warning: failed to prune empty session directories: ${error.message}\n`);
  }

  process.stdout.write(
    `Codex session cleanup: scanned=${rollouts.length} old=${candidates} ` +
      `protected=${protectedCount} unknown_owner=${unknownOwnership} open=${openCount} ` +
      `${options.apply ? "deleted" : "would_delete"}=${deleted} ` +
      `bytes=${deletedBytes} (${formatBytes(deletedBytes)}) empty_dirs=${emptyDirectories} ` +
      `failures=${failures}\n`
  );
  return { failures, deleted, deletedBytes };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    const result = pruneRuntimeSessions(options);
    if (result.failures > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) main();

export {
  collectSessionReferences,
  metadataBelongsToCortex,
  parseArgs,
  taskIsActive,
  reviewIsActive,
};
