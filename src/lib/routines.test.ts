import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTempWorkspace, moduleUrl, runTsxScript, writeJson } from "./test-harness";
import {
  buildZip,
  captureArtifacts,
  contentTypeFor,
  crc32,
  createRedactor,
  normalizeArtifactPath,
  resolveStoredArtifact,
} from "./routine-artifacts";
import { buildRoutinePrompt, parseRoutineReport } from "./routine-prompt";

const IMPORTS = [
  `import * as secrets from ${JSON.stringify(moduleUrl("src/lib/secret-store.ts"))};`,
  `import * as store from ${JSON.stringify(moduleUrl("src/lib/routine-store.ts"))};`,
  `import * as runner from ${JSON.stringify(moduleUrl("src/lib/routine-runner.ts"))};`,
  `import * as scheduler from ${JSON.stringify(moduleUrl("src/lib/routine-scheduler.ts"))};`,
  `import * as slack from ${JSON.stringify(moduleUrl("src/lib/slack.ts"))};`,
  `import * as api from ${JSON.stringify(moduleUrl("src/lib/routine-api.ts"))};`,
  `import fs from "node:fs";`,
  `import path from "node:path";`,
  `import { spawn } from "node:child_process";`,
];

function workspace(): string {
  const dir = createTempWorkspace("routines-test-");
  writeJson(path.join(dir, ".cortex", "config.json"), {
    max_parallel_sessions: 1,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    agents: {},
  });
  return dir;
}

function run(dir: string, body: string, env: Record<string, string> = {}) {
  return runTsxScript(dir, IMPORTS, body, {
    ...process.env,
    HOME: dir,
    CORTEX_SECRETS_KEY: "",
    CORTEX_SECRETS_KEY_FILE: "",
    CORTEX_DISABLE_DISK_GUARD: "1",
    CORTEX_PUBLIC_URL: "",
    ...env,
  });
}

// A fake Slack Web API that records calls.
const FAKE_FETCH = `
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: init && typeof init.body === "string" ? init.body : null });
    const respond = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith("/auth.test")) return respond({ ok: true, user: "cortex-city", team: "Marqo" });
    if (url.endsWith("/conversations.list")) {
      return respond({ ok: true, channels: [{ id: "C0123456", name: "product-metrics" }], response_metadata: { next_cursor: "" } });
    }
    if (url.endsWith("/chat.postMessage")) return respond({ ok: true });
    if (url.endsWith("/files.getUploadURLExternal")) return respond({ ok: true, upload_url: "https://files.example/upload", file_id: "F1" });
    if (url.startsWith("https://files.example/")) return new Response("ok", { status: 200 });
    if (url.endsWith("/files.completeUploadExternal")) return respond({ ok: true });
    if (url.endsWith("/users.lookupByEmail")) {
      return init.body.includes("missing%40x.com")
        ? respond({ ok: false, error: "users_not_found" })
        : respond({ ok: true, user: { id: "U0FARSHID" } });
    }
    if (url.endsWith("/conversations.open")) {
      return JSON.parse(init.body).users === "U0NOSCOPE"
        ? respond({ ok: false, error: "missing_scope", needed: "im:write" })
        : respond({ ok: true, channel: { id: "D0DIRECT1" } });
    }
    return respond({ ok: false, error: "unknown_method" });
  };
`;

// --- Pure helpers (in-process) ---

test("redactor replaces secret values, trimmed values and long lines of file secrets", () => {
  const redact = createRedactor([
    { name: "API_TOKEN", value: "tok_1234567890", kind: "env" },
    { name: "SHORT", value: "abc", kind: "env" },
    { name: "SA_JSON", value: '{\n  "private_key": "-----BEGIN KEY-----abcdefghijklmnop"\n}\n', kind: "file" },
  ]);
  assert.equal(redact("auth tok_1234567890 ok"), "auth [REDACTED:API_TOKEN] ok");
  assert.equal(redact("abc stays"), "abc stays");
  assert.match(redact('"private_key": "-----BEGIN KEY-----abcdefghijklmnop"'), /\[REDACTED:SA_JSON\]/);
  assert.equal(createRedactor([])("unchanged"), "unchanged");
  assert.equal(
    redact.buffer(Buffer.from("x tok_1234567890 y tok_1234567890")).toString(),
    "x [REDACTED:API_TOKEN] y [REDACTED:API_TOKEN]"
  );
  const binary = Buffer.from([0, 1, 2]);
  assert.equal(redact.buffer(binary), binary);
  assert.equal(createRedactor([]).buffer(binary), binary);
});

test("report parsing accepts objects, JSON text and fenced JSON, and rejects invalid reports", () => {
  const report = {
    status: "needs_attention",
    summary: "Activation fell.",
    artifacts: [{ path: "index.html", title: "Report", main: true }, { path: "" }, "bad"],
    slack_messages: [
      { channel: "#eng", text: "hi", attachments: ["index.html", 3] },
      { channel: "", text: "x" },
      null,
    ],
  };
  const parsed = parseRoutineReport(report);
  assert.equal(parsed?.status, "needs_attention");
  assert.deepEqual(parsed?.artifacts, [{ path: "index.html", title: "Report", main: true }]);
  assert.deepEqual(parsed?.slack_messages, [{ channel: "#eng", text: "hi", attachments: ["index.html"] }]);
  assert.equal(parseRoutineReport(JSON.stringify(report))?.summary, "Activation fell.");
  assert.equal(parseRoutineReport("Done!\n```json\n" + JSON.stringify(report) + "\n```")?.status, "needs_attention");
  assert.equal(parseRoutineReport("prefix " + JSON.stringify(report) + " suffix")?.status, "needs_attention");
  assert.equal(parseRoutineReport({ status: "weird", summary: "x" }), undefined);
  assert.equal(parseRoutineReport({ status: "completed" }), undefined);
  assert.equal(parseRoutineReport("not json"), undefined);
  assert.equal(parseRoutineReport("{broken"), undefined);
  assert.equal(parseRoutineReport({ status: "completed", summary: "ok" })?.artifacts.length, 0);
});

test("routine prompt names the output dir, secret descriptions (not values) and allowed channels", () => {
  const prompt = buildRoutinePrompt(
    { name: "Weekly", prompt: "Do the job.", slack: { allowed_channels: ["eng", "C0ABCDEFG"] } },
    {
      outputDir: "/tmp/out",
      runNumber: 3,
      now: new Date("2026-11-09T00:00:00Z"),
      secrets: [
        { name: "TOKEN", value: "secret-value", kind: "env", description: "Read-only" },
        { name: "SA", value: "{}", kind: "file", description: "" },
      ],
    }
  );
  assert.match(prompt, /\/tmp\/out/);
  assert.match(prompt, /`TOKEN` — Read-only/);
  assert.match(prompt, /`SA` \(a file/);
  assert.match(prompt, /#eng, C0ABCDEFG/);
  assert.doesNotMatch(prompt, /secret-value/);
  assert.match(prompt, /Do the job\./);
  const none = buildRoutinePrompt(
    { name: "x", prompt: "y", slack: { allowed_channels: [] } },
    { outputDir: "/o", runNumber: 1, secrets: [] }
  );
  assert.match(none, /No secrets are configured/);
  assert.match(none, /Allowed channels: none/);
});

test("artifact capture orders listed files first, redacts text, skips symlinks and enforces the size cap", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "routine-capture-"));
  const out = path.join(root, "out");
  const dest = path.join(root, "dest");
  mkdirSync(path.join(out, "charts"), { recursive: true });
  writeFileSync(path.join(out, "index.html"), "<p>key=tok_1234567890</p>");
  writeFileSync(path.join(out, "charts", "a.png"), Buffer.alloc(50, 1));
  writeFileSync(path.join(out, "notes.md"), "notes");
  writeFileSync(path.join(out, "config"), "TOKEN=tok_1234567890\n");
  writeFileSync(path.join(out, "big.csv"), "x".repeat(500));
  symlinkSync("/etc/passwd", path.join(out, "link.txt"));
  const redact = createRedactor([{ name: "API_TOKEN", value: "tok_1234567890", kind: "env" }]);
  const result = captureArtifacts(
    out,
    dest,
    [
      { path: "charts/a.png", title: "Chart", main: false },
      { path: path.join(out, "index.html"), title: "Report", main: true },
      { path: "../escape.html", title: "Nope", main: false },
      { path: "missing.html", title: "Missing", main: false },
    ],
    { maxBytes: 200, redact }
  );
  assert.deepEqual(result.artifacts.map((a) => a.path), ["index.html", "charts/a.png", "config", "notes.md"]);
  assert.equal(result.artifacts[0].main, true);
  assert.equal(result.artifacts[0].title, "Report");
  assert.equal(result.artifacts[2].listed, false);
  // Files of any type are redacted, including ones with no extension.
  assert.equal(readFileSync(path.join(dest, "config"), "utf-8"), "TOKEN=[REDACTED:API_TOKEN]\n");
  assert.equal(result.truncated, true);
  assert.deepEqual(result.skipped, ["big.csv"]);
  assert.match(readFileSync(path.join(dest, "index.html"), "utf-8"), /\[REDACTED:API_TOKEN\]/);
  assert.equal(resolveStoredArtifact(dest, "index.html"), path.join(dest, "index.html"));
  assert.equal(resolveStoredArtifact(dest, "../out/index.html"), undefined);
  assert.equal(resolveStoredArtifact(dest, "nope.html"), undefined);
  assert.equal(resolveStoredArtifact(dest, "charts"), undefined);
  assert.equal(normalizeArtifactPath(out, "/etc/passwd"), undefined);
  assert.equal(normalizeArtifactPath(out, "."), undefined);

  // Without an explicit main report, the first HTML file becomes the main one.
  const unlisted = captureArtifacts(out, path.join(root, "dest2"), [], { maxBytes: 10_000, redact });
  assert.equal(unlisted.artifacts.find((a) => a.main)?.path, "index.html");
  // A missing output directory captures nothing.
  assert.equal(captureArtifacts(path.join(root, "nope"), dest, [], { maxBytes: 1, redact }).artifacts.length, 0);
  // Binary files over the cap are skipped too.
  const binaryOnly = captureArtifacts(out, path.join(root, "dest3"), [{ path: "charts/a.png", title: "c", main: false }], { maxBytes: 10, redact });
  assert.ok(binaryOnly.skipped.includes("charts/a.png"));
});

test("content types and zip archives", () => {
  assert.equal(contentTypeFor("a.HTML"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("a.bin"), "application/octet-stream");
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
  const zip = buildZip([
    { name: "a.txt", data: Buffer.from("hello world") },
    { name: "dir/b.csv", data: Buffer.from("1,2,3") },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26);
  const compressedSize = zip.readUInt32LE(18);
  const data = zip.subarray(30 + nameLength, 30 + nameLength + compressedSize);
  assert.equal(inflateRawSync(data).toString(), "hello world");
  const end = zip.subarray(zip.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(10), 2);
});

// --- Stores (subprocess, isolated workspace) ---

test("secret store encrypts at rest, never lists values, validates names and keeps scopes apart", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const meta = await secrets.setSecret({ kind: "global" }, { name: "API_TOKEN", value: "tok_supersecret", description: " Read-only " });
      const raw = fs.readFileSync(".cortex/secrets/global.json", "utf-8");
      const mode = fs.statSync(".cortex/secrets/global.json").mode & 0o777;
      const keyMode = fs.statSync(path.join(process.env.HOME, ".config/cortex-city/secrets.key")).mode & 0o777;
      const updatedDescription = await secrets.setSecret({ kind: "global" }, { name: "API_TOKEN", description: "Changed" });
      const errors = [];
      for (const input of [
        { name: "lower", value: "x" },
        { name: "PATH", value: "x" },
        { name: "CORTEX_KEY", value: "x" },
        { name: "NEW_ONE" },
        { name: "EMPTY", value: "" },
        { name: "KIND", value: "x", kind: "weird" },
        { name: "LONG", value: "x", description: "d".repeat(501) },
        { name: "HUGE", value: "x".repeat(70000) },
      ]) {
        try { await secrets.setSecret({ kind: "global" }, input); errors.push("none"); }
        catch (error) { errors.push(error.name); }
      }
      await secrets.setSecret({ kind: "routine", routineId: "r1" }, { name: "API_TOKEN", value: "routine-value", kind: "file" });
      let badScope = "";
      try { secrets.secretFilePath({ kind: "routine", routineId: "../x" }); } catch (error) { badScope = error.name; }
      const values = secrets.readSecretValues({ kind: "global" }).map((s) => s.value);
      const routineValue = secrets.readSecretValue({ kind: "routine", routineId: "r1" }, "API_TOKEN");
      const deleted = await secrets.deleteSecret({ kind: "global" }, "API_TOKEN");
      const deletedAgain = await secrets.deleteSecret({ kind: "global" }, "API_TOKEN");
      await secrets.deleteSecretScope({ kind: "routine", routineId: "r1" });
      const gitignore = fs.readFileSync(".cortex/.gitignore", "utf-8");
      console.log(JSON.stringify({
        meta, leaked: raw.includes("tok_supersecret"), mode, keyMode, updatedDescription, errors, badScope,
        values, routineValue, deleted, deletedAgain,
        routineGone: !fs.existsSync(".cortex/secrets/routines/r1.json"),
        listAfter: secrets.listSecrets({ kind: "global" }),
        ignoresSecrets: gitignore.includes("secrets/"),
      }));
    `
  );
  assert.equal(result.meta.name, "API_TOKEN");
  assert.equal(result.meta.description, "Read-only");
  assert.equal(result.meta.kind, "env");
  assert.equal(result.meta.value, undefined);
  assert.equal(result.leaked, false);
  assert.equal(result.mode, 0o600);
  assert.equal(result.keyMode, 0o600);
  assert.equal(result.updatedDescription.description, "Changed");
  assert.deepEqual(result.errors, Array(8).fill("SecretValidationError"));
  assert.equal(result.badScope, "SecretValidationError");
  assert.deepEqual(result.values, ["tok_supersecret"]);
  assert.equal(result.routineValue, "routine-value");
  assert.equal(result.deleted, true);
  assert.equal(result.deletedAgain, false);
  assert.equal(result.routineGone, true);
  assert.deepEqual(result.listAfter, []);
  assert.equal(result.ignoresSecrets, true);
});

test("secret store uses CORTEX_SECRETS_KEY when set, and that key is required to decrypt", () => {
  const dir = workspace();
  run(dir, `await secrets.setSecret({ kind: "global" }, { name: "A_KEY", value: "value-one" }); console.log("{}");`, {
    CORTEX_SECRETS_KEY: "env-key-1",
  });
  const same = run(dir, `console.log(JSON.stringify(secrets.readSecretValue({ kind: "global" }, "A_KEY")));`, {
    CORTEX_SECRETS_KEY: "env-key-1",
  });
  assert.equal(same, "value-one");
  assert.throws(() =>
    run(dir, `console.log(JSON.stringify(secrets.readSecretValue({ kind: "global" }, "A_KEY")));`, {
      CORTEX_SECRETS_KEY: "other-key",
    })
  );
});

test("routine store validates input, schedules next runs and claims runs atomically", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const errors = [];
      for (const input of [
        { prompt: "p", cron: "0 9 * * 1" },
        { name: "n", cron: "0 9 * * 1" },
        { name: "n", prompt: "p", cron: "nope" },
        { name: "n", prompt: "p", cron: "0 0 9 * * 1" },
        { name: "n", prompt: "p", cron: "0 9 * * 1", timezone: "Mars/Base" },
        { name: "n", prompt: "p", cron: "0 9 * * 1", enabled: "yes" },
        { name: "n", prompt: "p", cron: "0 9 * * 1", agent_runner: "gpt" },
        { name: "n", prompt: "p", cron: "0 9 * * 1", timeout_minutes: 0 },
        { name: "n", prompt: "p", cron: "0 9 * * 1", global_secrets: [1] },
        { name: "n", prompt: "p", cron: "0 9 * * 1", slack: "eng" },
        { name: "n", prompt: "p", cron: "0 9 * * 1", slack: { allowed_channels: "eng" } },
        { name: "x".repeat(201), prompt: "p", cron: "0 9 * * 1" },
      ]) {
        try { await store.createRoutine(input); errors.push("none"); }
        catch (error) { errors.push(error.message); }
      }
      const created = await store.createRoutine({
        name: " Weekly metrics ", prompt: "Make a report", cron: "0  8 * * 1", timezone: "Australia/Sydney",
        agent_runner: "codex", model: " gpt-5 ", effort: "high", timeout_minutes: 15,
        global_secrets: ["A", "A", " B "], slack: { allowed_channels: ["#Product-Metrics", "C0ABCDEFG"], failure_channel: "#alerts" },
        keep_runs: 5, max_run_mb: 10,
      });
      const paused = await store.updateRoutine(created.id, { enabled: false, model: "", effort: "", agent_runner: "", timeout_minutes: null, keep_runs: null, max_run_mb: null });
      const resumed = await store.updateRoutine(created.id, { enabled: true });
      const missing = await store.updateRoutine("nope", { name: "x" });
      const requested = await store.requestRoutineRun(created.id);
      const manual = await store.claimRoutineRun(created.id, "manual", new Date("2026-11-09T00:00:00Z"));
      const scheduled = await store.claimRoutineRun(created.id, "schedule", new Date("2026-11-09T00:00:00Z"));
      const skipped = await store.claimRoutineRun(created.id, "schedule", new Date("2026-11-09T00:00:00Z"), "skipped", "busy");
      const afterClaims = store.getRoutine(created.id);
      const updatedRun = await store.updateRun(created.id, manual.id, (r) => ({ status: "succeeded", kept: !r.kept }));
      const missingRun = await store.updateRun(created.id, "nope", { status: "failed" });
      const active = store.hasActiveRun(created.id);
      const runs = store.listRuns(created.id).map((r) => [r.number, r.trigger, r.status]);
      fs.mkdirSync(store.runArtifactsDir(created.id, manual.id), { recursive: true });
      fs.writeFileSync(path.join(store.runArtifactsDir(created.id, manual.id), "a.txt"), "12345");
      const bytes = store.routineStorageBytes(created.id);
      const total = store.totalRoutineStorageBytes();
      const claimMissing = await store.claimRoutineRun("nope", "manual");
      const refused = await store.deleteRoutine(created.id);
      await store.updateRun(created.id, scheduled.id, { status: "failed" });
      const deleted = await store.deleteRoutine(created.id);
      const deletedAgain = await store.deleteRoutine(created.id);
      let badId = "";
      try { store.routineDataDir("../x"); } catch (error) { badId = error.message; }
      let badRun = "";
      try { store.runDataDir("ok", "../x"); } catch (error) { badRun = error.message; }
      fs.writeFileSync(".cortex/routines.json", "not json");
      console.log(JSON.stringify({
        errors, created, paused, resumed, missing, requested: Boolean(requested.run_requested_at),
        manual, scheduled, skipped, afterClaims, updatedRun, missingRun, active, runs, bytes, total, claimMissing,
        refused, deleted, deletedAgain, badId, badRun, afterCorruption: store.listRoutines(),
        preview: store.nextRunTimes("0 8 * * 1", "Australia/Sydney", new Date("2026-11-06T00:00:00Z"), 2).map((d) => d.toISOString()),
        dirSizeMissing: store.directorySize("/does/not/exist"),
        validIds: [store.isValidRoutineId("ab_C-1"), store.isValidRoutineId("a/b"), store.isValidRunId("x"), store.isValidRunId("")],
        channels: [store.normalizeChannel(" #Eng "), store.normalizeChannel("C0123ABCD")],
      }));
    `
  );
  assert.deepEqual(result.errors.map((e: string) => e.split(":")[0].split(" ")[0]), [
    "name", "prompt", "Use", "Use", "Unknown", "enabled", "agent_runner", "timeout_minutes",
    "global_secrets", "slack", "slack.allowed_channels", "name",
  ]);
  const created = result.created;
  assert.equal(created.name, "Weekly metrics");
  assert.equal(created.cron, "0 8 * * 1");
  assert.equal(created.model, "gpt-5");
  assert.deepEqual(created.global_secrets, ["A", "B"]);
  assert.deepEqual(created.slack, { allowed_channels: ["product-metrics", "C0ABCDEFG"], failure_channel: "alerts" });
  assert.ok(created.next_run_at);
  assert.equal(result.paused.enabled, false);
  assert.equal(result.paused.next_run_at, undefined);
  assert.equal(result.paused.model, undefined);
  assert.equal(result.paused.agent_runner, undefined);
  assert.equal(result.paused.timeout_minutes, undefined);
  assert.ok(result.resumed.next_run_at);
  assert.equal(result.missing, undefined);
  assert.equal(result.requested, true);
  assert.equal(result.manual.number, 1);
  assert.equal(result.manual.status, "queued");
  assert.equal(result.scheduled.number, 2);
  assert.ok(result.scheduled.scheduled_for);
  assert.equal(result.skipped.status, "skipped");
  assert.equal(result.skipped.error, "busy");
  assert.equal(result.afterClaims.run_requested_at, undefined);
  assert.equal(result.afterClaims.last_run_number, 3);
  assert.ok(Date.parse(result.afterClaims.next_run_at) > Date.parse("2026-11-09T00:00:00Z"));
  assert.equal(result.updatedRun.kept, true);
  assert.equal(result.missingRun, undefined);
  assert.equal(result.active, true);
  assert.deepEqual(result.runs, [[3, "schedule", "skipped"], [2, "schedule", "queued"], [1, "manual", "succeeded"]]);
  assert.equal(result.bytes, 5);
  assert.equal(result.total, 5);
  assert.equal(result.claimMissing, undefined);
  assert.equal(result.refused, "active");
  assert.equal(result.deleted, "deleted");
  assert.equal(result.deletedAgain, "not_found");
  assert.equal(result.badId, "Invalid routine id");
  assert.equal(result.badRun, "Invalid run id");
  assert.deepEqual(result.afterCorruption, []);
  assert.deepEqual(result.preview, ["2026-11-08T21:00:00.000Z", "2026-11-15T21:00:00.000Z"]);
  assert.equal(result.dirSizeMissing, 0);
  assert.deepEqual(result.validIds, [true, false, true, false]);
  assert.deepEqual(result.channels, ["eng", "C0123ABCD"]);
});

test("routine env passes only allowlisted variables, runtime auth and granted secrets", () => {
  const dir = workspace();
  writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=from-dotenv\nUNRELATED=nope\n");
  const result = run(
    dir,
    `
      fs.mkdirSync("ws/.secrets", { recursive: true });
      const env = runner.buildRoutineEnv(
        [
          { name: "API_TOKEN", value: "tok", kind: "env", description: "" },
          { name: "SA_JSON", value: "{\\"k\\":1}", kind: "file", description: "" },
        ],
        { workspace: path.resolve("ws"), outputDir: path.resolve("ws/out"), secretsDir: path.resolve("ws/.secrets"),
          routine: { id: "r1", name: "R" }, run: { number: 4 } },
        { PATH: "/bin", HOME: "/home/x", WORKER_SECRET: "leak", OPENAI_API_KEY: "from-env", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", GOOGLE_APPLICATION_CREDENTIALS: "/gcp.json" },
        path.resolve(".env")
      );
      console.log(JSON.stringify({ env, file: fs.readFileSync(env.SA_JSON, "utf-8"), mode: fs.statSync(env.SA_JSON).mode & 0o777 }));
    `
  );
  assert.equal(result.env.PATH, "/bin");
  assert.equal(result.env.WORKER_SECRET, undefined);
  assert.equal(result.env.UNRELATED, undefined);
  assert.equal(result.env.ANTHROPIC_API_KEY, "from-dotenv");
  assert.equal(result.env.OPENAI_API_KEY, "from-env");
  assert.equal(result.env.AWS_REGION, "us-east-1");
  assert.equal(result.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(result.env.API_TOKEN, "tok");
  assert.equal(result.env.CORTEX_ROUTINE_RUN, "4");
  assert.match(result.env.TMPDIR, /ws\/tmp$/);
  assert.equal(result.file, '{"k":1}');
  assert.equal(result.mode, 0o600);
});

test("stream text is redacted before it is truncated", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const secret = "sk_live_ABCDEFGHIJKLMNOP";
      const redact = (text) => text.split(secret).join("[REDACTED:KEY]");
      const longOutput = "x".repeat(1990) + "KEY=" + secret + "y".repeat(100);
      const text = runner.handleStreamEvent("claude", { type: "user", message: { content: [{ type: "tool_result", content: longOutput }] } }, {}, redact);
      const command = runner.handleStreamEvent("codex", { type: "item.completed", item: { type: "command_execution", command: "echo " + secret, aggregated_output: "" } }, {}, redact);
      console.log(JSON.stringify({ text, command }));
    `
  );
  // The cut lands inside the placeholder, never inside the secret.
  assert.doesNotMatch(result.text, /sk_live/);
  assert.match(result.text, /KEY=\[REDAC/);
  assert.equal(result.command, "CODEX (command)\n$ echo [REDACTED:KEY]\n\n");
});

test("process helpers recognise routine agents by working directory", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const root = runner.routineWorkspaceRoot();
      fs.mkdirSync(path.join(root, "run-x"), { recursive: true });
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: path.join(root, "run-x"), detached: true, stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const inside = runner.isRoutineProcess(child.pid);
      const self = runner.isRoutineProcess(process.pid);
      const gone = runner.isRoutineProcess(999999);
      const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
      runner.killProcessTree(child.pid, "SIGTERM");
      runner.killProcessTree(undefined, "SIGTERM");
      runner.killProcessTree(999999, "SIGTERM");
      console.log(JSON.stringify({ inside, self, gone, signal: await exited }));
    `
  );
  assert.equal(result.inside, true);
  assert.equal(result.self, false);
  assert.equal(result.gone, false);
  assert.equal(result.signal, "SIGTERM");
});

test("a routine whose secrets can't be decrypted fails without blocking other routines", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      await secrets.setSecret({ kind: "global" }, { name: "API_TOKEN", value: "tok_value_1234" });
      const broken = await store.createRoutine({ name: "Broken", prompt: "p", cron: "0 8 * * 1", global_secrets: ["API_TOKEN"], enabled: false });
      const healthy = await store.createRoutine({ name: "Healthy", prompt: "p", cron: "0 8 * * 1", enabled: false });
      await store.requestRoutineRun(broken.id);
      await store.requestRoutineRun(healthy.id);
      // The worker now uses a different key than the one that encrypted the secret.
      process.env.CORTEX_SECRETS_KEY = "a-different-key";
      secrets.__testUtils.resetKeyCache();
      const started = [];
      const deps = {
        now: () => new Date(), checkDisk: () => {}, log: () => {},
        runner: { spawn: () => { throw new Error("unused"); }, fetch: async () => new Response("{}"), now: () => new Date() },
        startRun: async (routine, runRecord) => {
          started.push(routine.name);
          if (routine.name === "Broken") return runner.startRoutineRun(routine, runRecord, deps.runner);
          await store.updateRun(routine.id, runRecord.id, { status: "succeeded" });
          return { completion: Promise.resolve() };
        },
      };
      const active = new Map();
      await scheduler.pollRoutines(active, deps);
      await Promise.all([...active.values()].map((entry) => entry.completion));
      // An orphaned run of the broken routine is finalized as failed, not left stuck.
      const orphan = await store.claimRoutineRun(broken.id, "manual");
      await store.updateRun(broken.id, orphan.id, { status: "running" });
      fs.mkdirSync(path.join(runner.runWorkspaceDir(orphan.id), "out"), { recursive: true });
      fs.writeFileSync(path.join(runner.runWorkspaceDir(orphan.id), "out", "leak.txt"), "tok_value_1234");
      await scheduler.pollRoutines(new Map(), deps);
      console.log(JSON.stringify({
        started,
        brokenRuns: store.listRuns(broken.id).map((r) => [r.status, r.error, r.artifacts.length]),
        healthyRuns: store.listRuns(healthy.id).map((r) => r.status),
      }));
    `
  );
  assert.deepEqual(result.started, ["Broken", "Healthy"]);
  assert.equal(result.brokenRuns.length, 2);
  for (const [status, error, artifacts] of result.brokenRuns) {
    assert.equal(status, "failed");
    assert.match(error, /secrets/);
    assert.equal(artifacts, 0);
  }
  assert.deepEqual(result.healthyRuns, ["succeeded"]);
});

test("finalizing never throws: a failure to save results still marks the run failed", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const routine = await store.createRoutine({ name: "R", prompt: "p", cron: "0 8 * * 1" });
      const claimed = await store.claimRoutineRun(routine.id, "manual");
      const failingRedactor = Object.assign(() => { throw new Error("redact exploded"); }, { buffer: () => { throw new Error("redact exploded"); } });
      const finished = await runner.finalizeRoutineRunSafely(routine, claimed, { status: "failed", error: "boom" }, runner.defaultRoutineRunnerDeps, failingRedactor);
      console.log(JSON.stringify({ finished }));
    `
  );
  assert.equal(result.finished.status, "failed");
  assert.match(result.finished.error, /boom\nCould not save this run's results: redact exploded/);
});

test("stream parsing understands Claude stream-json and Codex exec events", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const claude = {};
      const out = [];
      for (const event of [
        { type: "system", subtype: "init", session_id: "s-1" },
        { type: "assistant", message: { content: [{ type: "text", text: "Working" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
        { type: "assistant", message: { content: [] } },
        { type: "user", message: { content: [{ type: "tool_result", content: "file.txt" }, { type: "tool_result", content: [{ type: "text", text: "more" }] }, { type: "text" }] } },
        { type: "user", message: { content: [] } },
        { type: "result", session_id: "s-1", result: "done", is_error: false, structured_output: { status: "completed", summary: "ok" }, usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 2 } },
        { type: "other" },
      ]) out.push(runner.handleStreamEvent("claude", event, claude) ?? null);
      const codex = {};
      const codexOut = [];
      for (const event of [
        { type: "thread.started", thread_id: "t-1" },
        { type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "a\\nb" } },
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "failed", summary: "nope", artifacts: [], slack_messages: [] }) } },
        { type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 1, output_tokens: 3 } },
        { type: "error", message: "boom" },
        { type: "noise" },
      ]) codexOut.push(runner.handleStreamEvent("codex", event, codex) ?? null);
      console.log(JSON.stringify({
        out, claude, claudeReport: runner.reportFromStream(claude),
        codexOut, codex, codexReport: runner.reportFromStream(codex),
        fallback: runner.reportFromStream({ finalText: "no" }) ?? null,
      }));
    `
  );
  assert.equal(result.claude.sessionId, "s-1");
  assert.deepEqual(result.claude.usage, { input: 10, cached: 4, output: 2 });
  assert.match(result.out[1], /\[tool\] Bash/);
  assert.equal(result.out[2], null);
  assert.match(result.out[3], /file\.txt\nmore/);
  assert.equal(result.out[4], null);
  assert.equal(result.claudeReport.status, "completed");
  assert.equal(result.codex.sessionId, "t-1");
  assert.match(result.codexOut[1], /\$ ls\na\nb/);
  assert.deepEqual(result.codex.usage, { input: 7, cached: 1, output: 3 });
  assert.match(result.codexOut[4], /boom/);
  assert.equal(result.codexReport.status, "failed");
  assert.equal(result.fallback, null);
});

const FAKE_AGENT = `(() => {
  const fs = require("fs");
  const path = require("path");
  const out = process.env.CORTEX_OUTPUT_DIR;
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  fs.writeFileSync(path.join(out, "index.html"), "<h1>Report</h1><p>" + process.env.API_TOKEN + "</p>");
  fs.writeFileSync(path.join(out, "data.csv"), "a,b\\n1,2\\n");
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "system", subtype: "init", session_id: "sess-1" });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "token is " + process.env.API_TOKEN }] } });
  if (mode === "noreport") { console.error("something broke"); process.exit(2); }
  emit({ type: "result", session_id: "sess-1", result: "done", usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 },
    structured_output: {
      status: mode === "attention" ? "needs_attention" : "completed",
      summary: "Done with " + process.env.API_TOKEN,
      artifacts: [{ path: "index.html", title: "Weekly report", main: true }],
      slack_messages: [
        { channel: "#product-metrics", text: "Report ready " + process.env.API_TOKEN, attachments: ["index.html", "missing.png"] },
        { channel: "#exec", text: "nope", attachments: [] },
      ],
    } });
})();`;

function runnerScript(mode: string, extra = "") {
  return `
    ${FAKE_FETCH}
    await secrets.setSecret({ kind: "global" }, { name: "API_TOKEN", value: "tok_global_value", description: "Global token" });
    await secrets.setSecret({ kind: "routine", routineId: "placeholder" }, { name: "UNUSED", value: "x1234" });
    const routine = await store.createRoutine({
      name: "Weekly metrics", prompt: "Make the report", cron: "0 8 * * 1", global_secrets: ["API_TOKEN"],
      slack: { allowed_channels: ["product-metrics"], failure_channel: "alerts" }, timeout_minutes: 1,
    });
    await secrets.setSecret({ kind: "routine", routineId: routine.id }, { name: "API_TOKEN", value: "tok_routine_value" });
    await slack.connectSlack("xoxb-test", fakeFetch);
    calls.length = 0;
    const deps = {
      spawn: (command, args, options) => spawn(process.execPath, ["-e", ${JSON.stringify(FAKE_AGENT)}], { ...options, env: { ...options.env, FAKE_MODE: ${JSON.stringify(mode)} } }),
      fetch: fakeFetch,
      now: () => new Date(),
    };
    const claimed = await store.claimRoutineRun(routine.id, "manual");
    const started = await runner.startRoutineRun(store.getRoutine(routine.id), claimed, deps);
    ${extra}
    const finished = await started.completion;
    const transcript = fs.readFileSync(store.runTranscriptPath(routine.id, claimed.id), "utf-8");
    const html = fs.existsSync(path.join(store.runArtifactsDir(routine.id, claimed.id), "index.html"))
      ? fs.readFileSync(path.join(store.runArtifactsDir(routine.id, claimed.id), "index.html"), "utf-8") : "";
    console.log(JSON.stringify({
      finished, transcript, html, calls, pid: started.pid,
      workspaceGone: !fs.existsSync(runner.runWorkspaceDir(claimed.id)),
    }));
  `;
}

test("a routine run captures files, redacts secrets, records the report and sends allowed Slack messages", () => {
  const dir = workspace();
  const result = run(dir, runnerScript("ok"));
  const finished = result.finished;
  assert.equal(finished.status, "succeeded", finished.error + "\n" + result.transcript);
  assert.equal(finished.session_id, "sess-1");
  assert.equal(finished.input_tokens, 100);
  assert.equal(finished.runtime, "claude");
  assert.deepEqual(finished.secrets_used, [{ name: "API_TOKEN", scope: "routine" }]);
  assert.equal(finished.report.summary, "Done with [REDACTED:API_TOKEN]");
  assert.deepEqual(finished.artifacts.map((a: { path: string; main?: boolean; listed: boolean }) => [a.path, Boolean(a.main), a.listed]), [
    ["index.html", true, true],
    ["data.csv", false, false],
  ]);
  assert.match(result.html, /\[REDACTED:API_TOKEN\]/);
  assert.doesNotMatch(result.html, /tok_routine_value/);
  assert.doesNotMatch(result.transcript, /tok_routine_value/);
  assert.match(result.transcript, /token is \[REDACTED:API_TOKEN\]/);
  const [sent, refused] = finished.slack_messages;
  assert.equal(sent.status, "sent");
  assert.equal(sent.text, "Report ready [REDACTED:API_TOKEN]");
  assert.deepEqual(sent.attachments, ["index.html"]);
  assert.equal(refused.status, "refused");
  assert.equal(finished.slack_messages.length, 2);
  const methods = result.calls.map((call: { url: string }) => call.url.split("/").pop());
  assert.deepEqual(methods, ["conversations.list", "files.getUploadURLExternal", "upload", "files.completeUploadExternal"]);
  assert.ok(result.workspaceGone);
});

test("a run without a report fails, keeps partial files and posts a failure notice", () => {
  const dir = workspace();
  const result = run(dir, runnerScript("noreport"), { CORTEX_PUBLIC_URL: "https://cortex.example/" });
  const finished = result.finished;
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /without a valid report/);
  assert.match(finished.error, /something broke/);
  assert.equal(finished.artifacts.length, 2);
  const notice = finished.slack_messages[0];
  assert.equal(notice.kind, "failure_notice");
  assert.equal(notice.channel, "alerts");
  assert.match(notice.text, /run #1 failed/);
  assert.match(notice.text, /https:\/\/cortex\.example\/routines\//);
  assert.equal(notice.status, "failed"); // the fake workspace has no #alerts channel
  assert.match(notice.error, /not found/);
});

test("needs_attention reports map to the needs_attention status", () => {
  const dir = workspace();
  assert.equal(run(dir, runnerScript("attention")).finished.status, "needs_attention");
});

test("stopping a run from Cortex City marks it failed", () => {
  const dir = workspace();
  const result = run(
    dir,
    runnerScript(
      "hang",
      `await store.updateRun(routine.id, claimed.id, { stop_requested: true }); process.kill(started.pid, "SIGTERM");`
    )
  );
  assert.equal(result.finished.status, "failed");
  assert.equal(result.finished.error, "Stopped from Cortex City.");
});

test("missing global secrets fail the run before the agent starts", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const routine = await store.createRoutine({ name: "R", prompt: "p", cron: "0 8 * * 1", global_secrets: ["NOPE", "ALSO_NOPE"] });
      const claimed = await store.claimRoutineRun(routine.id, "manual");
      let spawned = false;
      const started = await runner.startRoutineRun(routine, claimed, { spawn: () => { spawned = true; }, fetch: async () => new Response("{}"), now: () => new Date() });
      const finished = await started.completion;
      console.log(JSON.stringify({ finished: store.getRun(routine.id, claimed.id), spawned, pid: started.pid ?? null }));
    `
  );
  assert.equal(result.spawned, false);
  assert.equal(result.pid, null);
  assert.equal(result.finished.status, "failed");
  assert.match(result.finished.error, /Missing secrets: NOPE, ALSO_NOPE/);
});

test("spawn failures, Codex arguments and Slack without a connection are handled", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const routine = await store.createRoutine({ name: "R", prompt: "p", cron: "0 8 * * 1", agent_runner: "codex", model: "gpt-5", slack: { allowed_channels: [], failure_channel: "alerts" } });
      const claimed = await store.claimRoutineRun(routine.id, "manual");
      let captured;
      const started = await runner.startRoutineRun(routine, claimed, {
        spawn: (command, args) => { captured = { command, args }; throw new Error("ENOENT"); },
        fetch: async () => new Response("{}"), now: () => new Date(),
      });
      const finished = await started.completion;
      const claimed2 = await store.claimRoutineRun(routine.id, "manual");
      const started2 = await runner.startRoutineRun(routine, claimed2, {
        spawn: (command, args, options) => spawn("/definitely/not/a/binary", [], options),
        fetch: async () => new Response("{}"), now: () => new Date(),
      });
      const finished2 = await started2.completion;
      console.log(JSON.stringify({ captured, finished, finished2 }));
    `
  );
  assert.equal(result.captured.command, "codex");
  assert.deepEqual(result.captured.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(result.captured.args.includes("--skip-git-repo-check"));
  assert.ok(result.captured.args.includes("gpt-5"));
  assert.equal(result.finished.status, "failed");
  assert.match(result.finished.error, /Could not start codex: ENOENT/);
  assert.equal(result.finished.slack_messages[0].status, "failed");
  assert.match(result.finished.slack_messages[0].error, /Slack isn't connected/);
  assert.equal(result.finished2.status, "failed");
  assert.match(result.finished2.error, /Could not start codex/);
});

test("Slack client: connect validates the token, posts plain messages and surfaces API errors", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      ${FAKE_FETCH}
      const errors = [];
      try { await slack.connectSlack("not-a-bot-token", fakeFetch); } catch (error) { errors.push(error.message); }
      const before = slack.getSlackConnection();
      const connected = await slack.connectSlack(" xoxb-abc ", fakeFetch);
      const token = slack.getSlackToken();
      await slack.sendSlackMessage(token, { channel: "C0999999", text: "hello", files: [] }, fakeFetch);
      slack.__testUtils.clearChannelCache();
      try { await slack.sendSlackMessage(token, { channel: "#missing", text: "x", files: [] }, fakeFetch); } catch (error) { errors.push(error.message); }
      try { await slack.sendSlackMessage(token, { channel: "C0999999", text: "x", files: [] }, async () => new Response("nope", { status: 500 })); } catch (error) { errors.push(error.message); }
      try { await slack.sendSlackMessage(token, { channel: "C0999999", text: "x", files: [] }, async () => new Response(JSON.stringify({ ok: false, error: "not_in_channel" }))); } catch (error) { errors.push(error.message); }
      fs.writeFileSync("file.txt", "x");
      try { await slack.sendSlackMessage(token, { channel: "C0999999", text: "x", files: [{ filePath: "file.txt", title: "f" }] }, async (url) => new Response(JSON.stringify({ ok: true }))); } catch (error) { errors.push(error.message); }
      try {
        await slack.sendSlackMessage(token, { channel: "C0999999", text: "x", files: [{ filePath: "file.txt", title: "f" }] }, async (url) =>
          url.startsWith("https://files.example") ? new Response("no", { status: 500 }) : fakeFetch(url));
      } catch (error) { errors.push(error.message); }
      const cachedId = await slack.resolveChannelId(token, "#product-metrics", fakeFetch);
      const cachedAgain = await slack.resolveChannelId(token, "product-metrics", async () => { throw new Error("should use cache"); });
      await slack.disconnectSlack();
      console.log(JSON.stringify({ errors, before, connected, token, calls, after: slack.getSlackConnection(), cachedId, cachedAgain }));
    `
  );
  assert.match(result.errors[0], /starts with xoxb-/);
  assert.match(result.errors[1], /#missing not found/);
  assert.match(result.errors[2], /HTTP 500/);
  assert.match(result.errors[3], /not_in_channel/);
  assert.match(result.errors[4], /did not return an upload URL/);
  assert.match(result.errors[5], /upload failed with HTTP 500/);
  assert.deepEqual(result.before, { connected: false });
  assert.equal(result.connected.description, "Connected as @cortex-city in Marqo");
  assert.equal(result.token, "xoxb-abc");
  const post = result.calls.find((call: { url: string }) => call.url.endsWith("chat.postMessage"));
  assert.deepEqual(JSON.parse(post.body), { channel: "C0999999", text: "hello", unfurl_links: false });
  assert.deepEqual(result.after, { connected: false });
  assert.equal(result.cachedId, "C0123456");
  assert.equal(result.cachedAgain, "C0123456");
});

test("scheduler runs due and requested routines, skips overlaps, reconciles interrupted runs and prunes", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const logs = [];
      const started = [];
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const deps = {
        now: () => new Date(),
        checkDisk: () => {},
        log: (message) => logs.push(message),
        runner: { spawn: () => { throw new Error("unused"); }, fetch: async () => new Response("{}"), now: () => new Date() },
        startRun: async (routine, runRecord) => {
          started.push(routine.name);
          await store.updateRun(routine.id, runRecord.id, { status: "running", pid: 999999 });
          return { pid: 999999, completion: gate.then(() => store.updateRun(routine.id, runRecord.id, { status: "succeeded", finished_at: new Date().toISOString() })) };
        },
      };
      const due = await store.createRoutine({ name: "Due", prompt: "p", cron: "0 8 * * 1" });
      await store.mutateRoutine(due.id, (r) => ({ ...r, next_run_at: "2020-01-01T00:00:00.000Z" }));
      const manual = await store.createRoutine({ name: "Manual", prompt: "p", cron: "0 8 * * 1", enabled: false });
      await store.requestRoutineRun(manual.id);
      const later = await store.createRoutine({ name: "Later", prompt: "p", cron: "0 8 * * 1" });
      await store.mutateRoutine(later.id, (r) => { const { next_run_at, ...rest } = r; return rest; });

      const active = new Map();
      await scheduler.pollRoutines(active, deps);
      const firstStarted = [...started];
      const activeAfterFirst = active.size;

      // The due routine comes due again while its run is still going: skipped.
      await store.mutateRoutine(due.id, (r) => ({ ...r, next_run_at: "2020-01-02T00:00:00.000Z" }));
      await store.requestRoutineRun(manual.id);
      await scheduler.pollRoutines(active, deps);
      const dueRuns = store.listRuns(due.id).map((r) => r.status);
      const manualStillRequested = Boolean(store.getRoutine(manual.id).run_requested_at);
      const laterHasNext = Boolean(store.getRoutine(later.id).next_run_at);

      release();
      await Promise.all([...active.values()].map((entry) => entry.completion));
      const activeAfterDone = active.size;

      // A run left "running" by a previous worker is finalized as interrupted.
      const orphan = await store.claimRoutineRun(later.id, "manual");
      await store.updateRun(later.id, orphan.id, { status: "running" });
      fs.mkdirSync(path.join(runner.runWorkspaceDir(orphan.id), "out"), { recursive: true });
      fs.writeFileSync(path.join(runner.runWorkspaceDir(orphan.id), "out", "partial.md"), "partial");
      fs.mkdirSync(path.join(runner.routineWorkspaceRoot(), "stale-dir"), { recursive: true });
      fs.writeFileSync(path.join(runner.routineWorkspaceRoot(), "stale-dir", runner.WORKSPACE_MARKER), "x");
      fs.mkdirSync(path.join(runner.routineWorkspaceRoot(), "not-ours"), { recursive: true });
      await store.updateRoutine(manual.id, { enabled: false });
      await store.mutateRoutine(manual.id, (r) => { const { run_requested_at, ...rest } = r; return rest; });
      await store.mutateRoutine(due.id, (r) => ({ ...r, next_run_at: "2999-01-01T00:00:00.000Z" }));
      await scheduler.pollRoutines(new Map(), deps);
      const orphanRun = store.getRun(later.id, orphan.id);
      const staleGone = !fs.existsSync(path.join(runner.routineWorkspaceRoot(), "stale-dir"));
      const foreignKept = fs.existsSync(path.join(runner.routineWorkspaceRoot(), "not-ours"));

      // Slack retries skip runs still finishing in this worker (no double send).
      const pendingRun = await store.claimRoutineRun(later.id, "manual");
      await store.updateRun(later.id, pendingRun.id, { status: "succeeded", slack_messages: [{ channel: "x", text: "t", attachments: [], kind: "agent", status: "pending", attempts: 0 }] });
      await scheduler.pollRoutines(new Map([[pendingRun.id, { routineId: later.id, completion: Promise.resolve() }]]), deps);
      const stillPending = store.getRun(later.id, pendingRun.id).slack_messages[0].status;
      await scheduler.pollRoutines(new Map(), deps);
      const retried = store.getRun(later.id, pendingRun.id).slack_messages[0].status;

      // Retention keeps the newest N plus kept runs; storage cap removes the oldest.
      const retained = await store.createRoutine({ name: "Retained", prompt: "p", cron: "0 8 * * 1", keep_runs: 2, enabled: false });
      const ids = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await store.claimRoutineRun(retained.id, "manual");
        await store.updateRun(retained.id, r.id, { status: "succeeded", finished_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), kept: i === 0 });
        fs.mkdirSync(store.runArtifactsDir(retained.id, r.id), { recursive: true });
        fs.writeFileSync(path.join(store.runArtifactsDir(retained.id, r.id), "f.bin"), Buffer.alloc(1024));
        ids.push(r.id);
      }
      const prunedByCount = await scheduler.pruneRoutineRuns([store.getRoutine(retained.id)], 1024 * 1024);
      const afterCount = store.listRuns(retained.id).map((r) => r.number);
      const prunedBySize = await scheduler.pruneRoutineRuns([store.getRoutine(retained.id)], 1500);
      const afterSize = store.listRuns(retained.id).map((r) => r.number);

      // Disk-guard and start failures fail the claimed run.
      const failing = await store.createRoutine({ name: "Failing", prompt: "p", cron: "0 8 * * 1", enabled: false });
      await store.requestRoutineRun(failing.id);
      await scheduler.pollRoutines(new Map(), { ...deps, checkDisk: () => { throw new Error("Low disk space"); } });
      await store.requestRoutineRun(failing.id);
      await scheduler.pollRoutines(new Map(), { ...deps, startRun: async () => { throw new Error("cannot start"); } });
      const failingRuns = store.listRuns(failing.id).map((r) => [r.status, r.error]);

      scheduler.stopActiveRoutineRuns(new Map([["x", { routineId: "r", pid: 999999, completion: Promise.resolve() }], ["y", { routineId: "r", completion: Promise.resolve() }]]));
      console.log(JSON.stringify({
        firstStarted, activeAfterFirst, dueRuns, manualStillRequested, laterHasNext, activeAfterDone,
        orphanRun, staleGone, foreignKept, stillPending, retried, prunedByCount, afterCount, prunedBySize, afterSize, failingRuns,
        summary: api.summarizeRoutine(store.getRoutine(retained.id)),
        usage: api.globalSecretUsage(),
        sweptNothing: scheduler.sweepRoutineWorkspaces(new Map()),
      }));
    `
  );
  assert.deepEqual(result.firstStarted, ["Manual", "Due"]);
  assert.equal(result.activeAfterFirst, 2);
  assert.deepEqual(result.dueRuns, ["skipped", "running"]);
  assert.equal(result.manualStillRequested, true);
  assert.equal(result.laterHasNext, true);
  assert.equal(result.activeAfterDone, 0);
  assert.equal(result.orphanRun.status, "failed");
  assert.match(result.orphanRun.error, /worker restarted/);
  assert.deepEqual(result.orphanRun.artifacts.map((a: { path: string }) => a.path), ["partial.md"]);
  assert.equal(result.staleGone, true);
  assert.equal(result.foreignKept, true);
  assert.equal(result.stillPending, "pending");
  assert.equal(result.retried, "failed");
  // Keep last 2, plus the kept run on top.
  assert.equal(result.prunedByCount, 2);
  assert.deepEqual(result.afterCount, [5, 4, 1]);
  assert.equal(result.prunedBySize, 2);
  assert.deepEqual(result.afterSize, [1]);
  assert.deepEqual(result.failingRuns, [
    ["failed", "cannot start"],
    ["failed", "Low disk space"],
  ]);
  assert.equal(result.summary.last_run.number, 1);
  assert.equal(result.summary.storage_bytes, 1024);
  assert.equal(result.sweptNothing, 0);
});

test("routine API helpers find records, read JSON bodies and map validation errors", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      const routine = await store.createRoutine({ name: "R", prompt: "p", cron: "0 8 * * 1" });
      const claimed = await store.claimRoutineRun(routine.id, "manual");
      const detail = api.routineDetail(routine);
      const pausedDetail = api.routineDetail({ ...routine, enabled: false });
      const brokenDetail = api.routineDetail({ ...routine, cron: "garbage" });
      const found = api.findRun(routine.id, claimed.id);
      const statuses = [];
      statuses.push(api.notFound().status);
      statuses.push(api.validationErrorResponse(new store.RoutineValidationError("bad")).status);
      statuses.push(api.validationErrorResponse(new secrets.SecretValidationError("bad")).status);
      statuses.push(api.validationErrorResponse(new slack.SlackError("bad")).status);
      let rethrown = "";
      try { api.validationErrorResponse(new Error("boom")); } catch (error) { rethrown = error.message; }
      const bodies = [
        await api.readJsonBody(new Request("http://x", { method: "POST", body: "{\\"a\\":1}" })),
        await api.readJsonBody(new Request("http://x", { method: "POST", body: "[1]" })),
        await api.readJsonBody(new Request("http://x", { method: "POST", body: "nope" })),
      ];
      console.log(JSON.stringify({
        nextRuns: detail.next_runs.length, pausedRuns: pausedDetail.next_runs.length, brokenRuns: brokenDetail.next_runs.length,
        activeRunId: detail.routine.active_run_id === claimed.id,
        found: found?.run.id === claimed.id,
        missingRoutine: api.findRoutine("../x") ?? null,
        missingRun: api.findRun(routine.id, "../x") ?? null,
        missingRun2: api.findRun(routine.id, "nope") ?? null,
        statuses, rethrown, bodies: bodies.map((b) => b ?? null),
        csp: api.ARTIFACT_CSP.includes("connect-src 'none'"),
      }));
    `
  );
  assert.equal(result.nextRuns, 4);
  assert.equal(result.pausedRuns, 0);
  assert.equal(result.brokenRuns, 0);
  assert.equal(result.activeRunId, true);
  assert.equal(result.found, true);
  assert.equal(result.missingRoutine, null);
  assert.equal(result.missingRun, null);
  assert.equal(result.missingRun2, null);
  assert.deepEqual(result.statuses, [404, 400, 400, 400]);
  assert.equal(result.rethrown, "boom");
  assert.deepEqual(result.bodies, [{ a: 1 }, null, null]);
  assert.equal(result.csp, true);
});

test("Slack test message resolves the person, opens a DM and posts to it", () => {
  const dir = workspace();
  const result = run(
    dir,
    `
      ${FAKE_FETCH}
      const errors = [];
      try { await slack.sendSlackTestMessage("me@x.com", fakeFetch); } catch (error) { errors.push(error.message); }
      await slack.connectSlack("xoxb-test", fakeFetch);
      calls.length = 0;
      const byEmail = await slack.sendSlackTestMessage(" me@x.com ", fakeFetch);
      const posted = JSON.parse(calls.find((call) => call.url.endsWith("chat.postMessage")).body);
      calls.length = 0;
      const byIdWithoutDmScope = await slack.sendSlackTestMessage("U0NOSCOPE", fakeFetch);
      const postedToUser = JSON.parse(calls.find((call) => call.url.endsWith("chat.postMessage")).body);
      for (const target of ["not an address", "missing@x.com"]) {
        try { await slack.sendSlackTestMessage(target, fakeFetch); } catch (error) { errors.push(error.message); }
      }
      try {
        await slack.sendSlackTestMessage("U0FARSHID", async (url) =>
          url.endsWith("chat.postMessage")
            ? new Response(JSON.stringify({ ok: false, error: "missing_scope", needed: "chat:write" }))
            : fakeFetch(url, { body: JSON.stringify({ users: "U0FARSHID" }) }));
      } catch (error) { errors.push(error.message); }
      console.log(JSON.stringify({ errors, byEmail, posted, byIdWithoutDmScope, postedToUser }));
    `
  );
  assert.match(result.errors[0], /isn't connected/);
  assert.deepEqual(result.byEmail, { user_id: "U0FARSHID" });
  assert.equal(result.posted.channel, "D0DIRECT1");
  assert.match(result.posted.text, /test message from Cortex City/);
  assert.deepEqual(result.byIdWithoutDmScope, { user_id: "U0NOSCOPE" });
  assert.equal(result.postedToUser.channel, "U0NOSCOPE");
  assert.match(result.errors[1], /email address or member ID/);
  assert.match(result.errors[2], /users_not_found/);
  assert.match(result.errors[3], /missing_scope \(the bot needs the chat:write scope\)/);
});
