import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

import { createSessionLog, deleteTaskLogs } from "./logger";

// logger.ts captures process.cwd() at import time, so we test against the real
// project logs/ directory. Files are namespaced by a per-test nanoid so
// concurrent test runs don't collide.
const LOGS_DIR = path.join(process.cwd(), "logs");

function ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function cleanupTask(taskId: string) {
  if (!existsSync(LOGS_DIR)) return;
  for (const file of readdirSync(LOGS_DIR)) {
    if (file.includes(taskId)) {
      try {
        unlinkSync(path.join(LOGS_DIR, file));
      } catch {
        // best effort
      }
    }
  }
}

test("createSessionLog opens machine + transcript streams with a header", async () => {
  const taskId = `logger-test-${nanoid(8)}`;
  ensureLogsDir();
  try {
    const session = createSessionLog(taskId);
    session.machine.write("hi machine\n");
    session.transcript.write("hi transcript\n");
    await new Promise<void>((resolve) => {
      let pending = 2;
      const done = () => {
        if (--pending === 0) resolve();
      };
      session.machine.end(done);
      session.transcript.end(done);
    });
    assert.equal(existsSync(session.machinePath), true);
    assert.equal(existsSync(session.transcriptPath), true);
    assert.match(
      readFileSync(session.machinePath, "utf-8"),
      /--- Session started at .+ ---/
    );
    assert.match(
      readFileSync(session.transcriptPath, "utf-8"),
      /hi transcript/
    );
  } finally {
    cleanupTask(taskId);
  }
});

test("deleteTaskLogs removes only files matching the task id", () => {
  const taskId = `logger-test-${nanoid(8)}`;
  const otherTaskId = `logger-test-${nanoid(8)}`;
  ensureLogsDir();
  const taskLog = path.join(LOGS_DIR, `task-${taskId}-2026-05-01.jsonl`);
  const taskTranscript = path.join(LOGS_DIR, `task-${taskId}-2026-05-01.log`);
  const otherLog = path.join(LOGS_DIR, `task-${otherTaskId}-2026-05-01.log`);
  writeFileSync(taskLog, "x");
  writeFileSync(taskTranscript, "x");
  writeFileSync(otherLog, "x");
  try {
    deleteTaskLogs(taskId);
    assert.equal(existsSync(taskLog), false);
    assert.equal(existsSync(taskTranscript), false);
    assert.equal(existsSync(otherLog), true);
  } finally {
    cleanupTask(taskId);
    cleanupTask(otherTaskId);
  }
});

test("deleteTaskLogs handles regex-special task ids safely", () => {
  const id = `logger.test.${nanoid(4)}`;
  const idLiteral = `loggerXtestX${id.slice(13)}`;
  ensureLogsDir();
  const literalFile = path.join(LOGS_DIR, `task-${id}-2026-05-01.log`);
  const decoyFile = path.join(LOGS_DIR, `task-${idLiteral}-2026-05-01.log`);
  writeFileSync(literalFile, "x");
  writeFileSync(decoyFile, "x");
  try {
    deleteTaskLogs(id);
    assert.equal(existsSync(literalFile), false);
    // `.` in the task id must be escaped — the decoy with literal chars stays.
    assert.equal(existsSync(decoyFile), true);
  } finally {
    cleanupTask(id);
    cleanupTask(idLiteral);
  }
});

test("deleteTaskLogs is a no-op when no files match", () => {
  // Should not throw — covers the happy "nothing matched" path.
  ensureLogsDir();
  deleteTaskLogs(`nonexistent-${nanoid(10)}`);
});
