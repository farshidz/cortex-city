// In-process tests for runtime-args internals.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { __testUtils } from "./runtime-args";

const { loadEnvFile } = __testUtils;

test("loadEnvFile parses key=value lines, strips quotes, and ignores comments", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runtime-args-loadenv-"));
  const envPath = path.join(dir, ".env");
  writeFileSync(
    envPath,
    [
      "# a comment",
      "",
      "PLAIN=value",
      'DOUBLE_QUOTED="quoted value"',
      "SINGLE_QUOTED='single value'",
      "WITH_EQUALS=foo=bar",
      "  PADDED =  has padding ",
      "no-equals-line",
    ].join("\n")
  );
  const parsed = loadEnvFile(envPath);
  assert.equal(parsed.PLAIN, "value");
  assert.equal(parsed.DOUBLE_QUOTED, "quoted value");
  assert.equal(parsed.SINGLE_QUOTED, "single value");
  assert.equal(parsed.WITH_EQUALS, "foo=bar");
  assert.equal(parsed.PADDED, "has padding");
  assert.equal("no-equals-line" in parsed, false);
});

test("loadEnvFile returns an empty record when the file is missing", () => {
  const parsed = loadEnvFile("/path/that/does/not/exist/.env");
  assert.deepEqual(parsed, {});
});
