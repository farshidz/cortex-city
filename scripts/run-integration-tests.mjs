#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const repoRoot = process.cwd();
const testsRoot = path.join(repoRoot, "src", "integration");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const maxConcurrency = Number.parseInt(
  process.env.INTEGRATION_TEST_CONCURRENCY || "",
  10
) || Math.max(1, Math.min(os.availableParallelism(), 4));

function findIntegrationTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findIntegrationTests(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function prefixStream(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    target.write(`[${label}] ${line}\n`);
  });
}

async function runFile(file) {
  const label = path.basename(file);
  const child = spawn(tsxBin, ["--test", file], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  prefixStream(child.stdout, label, process.stdout);
  prefixStream(child.stderr, label, process.stderr);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

async function main() {
  const files = findIntegrationTests(testsRoot);
  if (files.length === 0) {
    process.stdout.write("No integration tests found.\n");
    return;
  }

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(maxConcurrency, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex];
        nextIndex += 1;
        await runFile(file);
      }
    }
  );

  await Promise.all(workers);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
