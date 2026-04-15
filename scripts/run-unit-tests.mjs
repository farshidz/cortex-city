#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const testsRoot = path.join(repoRoot, "src", "lib");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

function findUnitTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findUnitTests(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function main() {
  const files = findUnitTests(testsRoot);
  if (files.length === 0) {
    process.stdout.write("No unit tests found.\n");
    return;
  }

  const child = spawn(tsxBin, ["--test", ...files], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
