import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function runRoutes(body: string) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "routine-routes-test-"));
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      `
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const path = require("node:path");
        (async () => {
          const workspace = process.argv[1];
          const repoRoot = process.argv[2];
          process.chdir(workspace);
          fs.mkdirSync(".cortex", { recursive: true });
          fs.writeFileSync(".cortex/config.json", JSON.stringify({ max_parallel_sessions: 1, poll_interval_seconds: 30, default_permission_mode: "bypassPermissions", default_agent_runner: "claude", agents: {} }));
          const load = async (relativePath) => { const imported = await import(new URL(relativePath, \`file://\${repoRoot}/\`).href); return imported.default || imported; };
          const { NextRequest } = await import("next/server");
          const req = (url, init = {}) => new NextRequest("http://localhost" + url, init);
          const jsonReq = (url, method, body) => req(url, { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
          const json = async (response) => ({ status: response.status, body: await response.json() });
          const ctx = (params) => ({ params: Promise.resolve(params) });
          ${body}
          console.log(JSON.stringify({ ok: true }));
        })().catch((error) => { console.error(error); process.exit(1); });
      `,
      workspace,
      REPO_ROOT,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        CORTEX_ENABLE_WORKER_AUTOSTART: "0",
        CORTEX_SECRETS_KEY: "",
        CORTEX_SECRETS_KEY_FILE: "",
        HOME: workspace,
      },
    }
  );
  assert.match(output, /\{"ok":true\}/);
}

test("routine routes create, read, update, run and delete routines", () => {
  runRoutes(`
    const list = await load("src/app/api/routines/route.ts");
    const one = await load("src/app/api/routines/[id]/route.ts");
    const runNow = await load("src/app/api/routines/[id]/run/route.ts");
    const preview = await load("src/app/api/routines/schedule-preview/route.ts");
    const store = await load("src/lib/routine-store.ts");

    assert.deepEqual((await json(await list.GET())).body, []);
    assert.equal((await list.POST(jsonReq("/api/routines", "POST", "[1]"))).status, 400);
    assert.equal((await list.POST(jsonReq("/api/routines", "POST", "not json"))).status, 400);
    const invalid = await json(await list.POST(jsonReq("/api/routines", "POST", { name: "x", prompt: "p", cron: "bad" })));
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /5-field cron/);

    const created = await json(await list.POST(jsonReq("/api/routines", "POST", {
      name: "Weekly", prompt: "Report", cron: "0 8 * * 1", timezone: "Australia/Sydney",
    })));
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.storage_bytes, 0);
    assert.ok(created.body.next_run_at);

    const listed = await json(await list.GET());
    assert.equal(listed.body.length, 1);

    const detail = await json(await one.GET(req("/api/routines/" + id), ctx({ id })));
    assert.equal(detail.body.routine.name, "Weekly");
    assert.equal(detail.body.next_runs.length, 4);
    assert.deepEqual(detail.body.runs, []);
    assert.deepEqual(detail.body.secrets, []);
    assert.equal((await one.GET(req("/api/routines/nope"), ctx({ id: "../bad" }))).status, 404);
    assert.equal((await one.GET(req("/api/routines/nope"), ctx({ id: "missing" }))).status, 404);

    const paused = await json(await one.PUT(jsonReq("/api/routines/" + id, "PUT", { enabled: false }), ctx({ id })));
    assert.equal(paused.body.routine.enabled, false);
    assert.deepEqual(paused.body.next_runs, []);
    assert.equal((await one.PUT(jsonReq("/api/routines/" + id, "PUT", { timezone: "Nope/Nope" }), ctx({ id }))).status, 400);
    assert.equal((await one.PUT(jsonReq("/api/routines/" + id, "PUT", "[]"), ctx({ id }))).status, 400);
    assert.equal((await one.PUT(jsonReq("/api/routines/x", "PUT", {}), ctx({ id: "missing" }))).status, 404);

    const requested = await json(await runNow.POST(req("/api/routines/" + id + "/run", { method: "POST" }), ctx({ id })));
    assert.equal(requested.body.ok, true);
    assert.ok(requested.body.requested_at);
    assert.equal((await runNow.POST(req("/x", { method: "POST" }), ctx({ id: "missing" }))).status, 404);

    const okPreview = await json(await preview.GET(req("/api/routines/schedule-preview?cron=0%209%20*%20*%201-5&timezone=UTC")));
    assert.equal(okPreview.body.next_runs.length, 4);
    const badPreview = await json(await preview.GET(req("/api/routines/schedule-preview?cron=0%209")));
    assert.equal(badPreview.status, 400);

    // A routine with an active run can't be deleted.
    const claimed = await store.claimRoutineRun(id, "manual");
    assert.equal((await one.DELETE(req("/x", { method: "DELETE" }), ctx({ id }))).status, 409);
    await store.updateRun(id, claimed.id, { status: "succeeded" });
    assert.equal((await one.DELETE(req("/x", { method: "DELETE" }), ctx({ id }))).status, 200);
    assert.equal((await one.DELETE(req("/x", { method: "DELETE" }), ctx({ id }))).status, 404);
  `);
});

test("secret routes are write-only and report which routines use a global secret", () => {
  runRoutes(`
    const list = await load("src/app/api/routines/route.ts");
    const globals = await load("src/app/api/secrets/route.ts");
    const routineSecrets = await load("src/app/api/routines/[id]/secrets/route.ts");

    const saved = await json(await globals.PUT(jsonReq("/api/secrets", "PUT", { name: "API_TOKEN", value: "tok_value_123", description: "Read-only" })));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.value, undefined);
    assert.equal((await globals.PUT(jsonReq("/api/secrets", "PUT", { name: "bad name", value: "x" }))).status, 400);
    assert.equal((await globals.PUT(jsonReq("/api/secrets", "PUT", "nope"))).status, 400);

    const created = await json(await list.POST(jsonReq("/api/routines", "POST", { name: "R", prompt: "p", cron: "0 8 * * 1", global_secrets: ["API_TOKEN"] })));
    const id = created.body.id;
    const own = await json(await routineSecrets.PUT(jsonReq("/x", "PUT", { name: "API_TOKEN", value: "own", kind: "file" }), ctx({ id })));
    assert.equal(own.body.kind, "file");
    assert.equal((await routineSecrets.PUT(jsonReq("/x", "PUT", { name: "X" }), ctx({ id }))).status, 400);
    assert.equal((await routineSecrets.PUT(jsonReq("/x", "PUT", "[]"), ctx({ id }))).status, 400);
    assert.equal((await routineSecrets.PUT(jsonReq("/x", "PUT", { name: "X", value: "y" }), ctx({ id: "missing" }))).status, 404);
    const ownList = await json(await routineSecrets.GET(req("/x"), ctx({ id })));
    assert.deepEqual(ownList.body.map((s) => s.name), ["API_TOKEN"]);
    assert.equal((await routineSecrets.GET(req("/x"), ctx({ id: "missing" }))).status, 404);

    const listed = await json(await globals.GET());
    assert.equal(listed.body[0].name, "API_TOKEN");
    assert.equal(JSON.stringify(listed.body).includes("tok_value_123"), false);
    assert.deepEqual(listed.body[0].used_by, [{ id, name: "R", overridden: true }]);

    assert.equal((await routineSecrets.DELETE(req("/x?name=API_TOKEN", { method: "DELETE" }), ctx({ id }))).status, 200);
    assert.equal((await routineSecrets.DELETE(req("/x?name=API_TOKEN", { method: "DELETE" }), ctx({ id }))).status, 404);
    assert.equal((await routineSecrets.DELETE(req("/x?name=A", { method: "DELETE" }), ctx({ id: "missing" }))).status, 404);
    const removed = await json(await globals.DELETE(req("/api/secrets?name=API_TOKEN", { method: "DELETE" })));
    assert.deepEqual(removed.body.used_by, [{ id, name: "R", overridden: false }]);
    assert.equal((await globals.DELETE(req("/api/secrets?name=API_TOKEN", { method: "DELETE" }))).status, 404);
  `);
});

test("run routes serve sandboxed artifacts, zips, transcripts, keep flags and stop requests", () => {
  runRoutes(`
    const list = await load("src/app/api/routines/route.ts");
    const runRoute = await load("src/app/api/routines/[id]/runs/[runId]/route.ts");
    const artifactRoute = await load("src/app/api/routines/[id]/runs/[runId]/artifacts/[...path]/route.ts");
    const zipRoute = await load("src/app/api/routines/[id]/runs/[runId]/download/route.ts");
    const transcriptRoute = await load("src/app/api/routines/[id]/runs/[runId]/transcript/route.ts");
    const store = await load("src/lib/routine-store.ts");

    const id = (await json(await list.POST(jsonReq("/api/routines", "POST", { name: "Weekly metrics!", prompt: "p", cron: "0 8 * * 1" })))).body.id;
    const claimed = await store.claimRoutineRun(id, "manual");
    const runId = claimed.id;
    const artifactsDir = store.runArtifactsDir(id, runId);
    fs.mkdirSync(path.join(artifactsDir, "charts"), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, "index.html"), "<h1>Hi</h1>");
    fs.writeFileSync(path.join(artifactsDir, "charts", "a b.csv"), "1,2");
    fs.writeFileSync(path.join(artifactsDir, "100% done.html"), "done");
    fs.writeFileSync(path.join(artifactsDir, "报告.html"), "report");

    assert.equal((await zipRoute.GET(req("/x"), ctx({ id, runId }))).status, 404);
    assert.equal((await transcriptRoute.GET(req("/x"), ctx({ id, runId }))).status, 200);

    await store.updateRun(id, runId, {
      status: "succeeded",
      artifacts: [
        { path: "index.html", title: "Report", size: 11, content_type: "text/html; charset=utf-8", main: true, listed: true },
        { path: "charts/a b.csv", title: "Data", size: 3, content_type: "text/csv; charset=utf-8", listed: false },
        { path: "100% done.html", title: "Done", size: 4, content_type: "text/html; charset=utf-8", listed: false },
        { path: "报告.html", title: "Report", size: 6, content_type: "text/html; charset=utf-8", listed: false },
      ],
    });
    fs.writeFileSync(store.runTranscriptPath(id, runId), "CLAUDE\\nhello\\n");

    const detail = await json(await runRoute.GET(req("/x"), ctx({ id, runId })));
    assert.equal(detail.body.routine.name, "Weekly metrics!");
    assert.equal(detail.body.run.artifacts.length, 4);
    assert.equal((await runRoute.GET(req("/x"), ctx({ id, runId: "missing" }))).status, 404);
    assert.equal((await runRoute.GET(req("/x"), ctx({ id, runId: "../x" }))).status, 404);

    const html = await artifactRoute.GET(req("/x"), ctx({ id, runId, path: ["index.html"] }));
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy"), /sandbox allow-scripts/);
    assert.match(html.headers.get("content-security-policy"), /connect-src 'none'/);
    assert.match(html.headers.get("content-disposition"), /^inline/);
    assert.equal(await html.text(), "<h1>Hi</h1>");
    // Next.js passes catch-all segments already decoded.
    const csv = await artifactRoute.GET(req("/x?download=1"), ctx({ id, runId, path: ["charts", "a b.csv"] }));
    assert.match(csv.headers.get("content-disposition"), /^attachment; filename="a b.csv"; filename[*]=UTF-8''a%20b.csv/);
    assert.equal(await (await artifactRoute.GET(req("/x"), ctx({ id, runId, path: ["100% done.html"] }))).text(), "done");
    const unicode = await artifactRoute.GET(req("/x"), ctx({ id, runId, path: ["报告.html"] }));
    assert.equal(await unicode.text(), "report");
    assert.match(unicode.headers.get("content-disposition"), /filename="__[.]html"; filename[*]=UTF-8''%E6%8A%A5%E5%91%8A[.]html/);
    assert.equal((await artifactRoute.GET(req("/x"), ctx({ id, runId, path: ["..", "..", "secrets", "global.json"] }))).status, 404);
    assert.equal((await artifactRoute.GET(req("/x"), ctx({ id, runId, path: ["missing.html"] }))).status, 404);
    assert.equal((await artifactRoute.GET(req("/x"), ctx({ id, runId: "missing", path: ["index.html"] }))).status, 404);

    const zip = await zipRoute.GET(req("/x"), ctx({ id, runId }));
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.match(zip.headers.get("content-disposition"), /Weekly-metrics-run-1\\.zip/);
    assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    assert.equal((await zipRoute.GET(req("/x"), ctx({ id, runId: "missing" }))).status, 404);

    const transcript = await transcriptRoute.GET(req("/x"), ctx({ id, runId }));
    assert.equal(await transcript.text(), "CLAUDE\\nhello\\n");
    assert.equal((await transcriptRoute.GET(req("/x"), ctx({ id, runId: "missing" }))).status, 404);

    const kept = await json(await runRoute.PATCH(jsonReq("/x", "PATCH", { kept: true }), ctx({ id, runId })));
    assert.equal(kept.body.run.kept, true);
    assert.equal((await runRoute.PATCH(jsonReq("/x", "PATCH", { kept: "yes" }), ctx({ id, runId }))).status, 400);
    assert.equal((await runRoute.PATCH(jsonReq("/x", "PATCH", "nope"), ctx({ id, runId }))).status, 400);
    assert.equal((await runRoute.PATCH(jsonReq("/x", "PATCH", { action: "stop" }), ctx({ id, runId }))).status, 409);
    assert.equal((await runRoute.PATCH(jsonReq("/x", "PATCH", { kept: true }), ctx({ id, runId: "missing" }))).status, 404);

    await store.updateRun(id, runId, { status: "running", pid: 999999 });
    const stopped = await json(await runRoute.PATCH(jsonReq("/x", "PATCH", { action: "stop" }), ctx({ id, runId })));
    assert.equal(stopped.body.ok, true);
    assert.equal(store.getRun(id, runId).stop_requested, true);
  `);
});

test("Slack integration route reports status, rejects non-bot tokens and disconnects", () => {
  runRoutes(`
    const route = await load("src/app/api/integrations/slack/route.ts");
    assert.deepEqual((await json(await route.GET())).body, { connected: false });
    assert.equal((await route.PUT(jsonReq("/x", "PUT", {}))).status, 400);
    const bad = await json(await route.PUT(jsonReq("/x", "PUT", { token: "xoxp-user-token" })));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /xoxb-/);
    const secrets = await load("src/lib/secret-store.ts");
    await secrets.setSecret({ kind: "system" }, { name: "SLACK_BOT_TOKEN", value: "xoxb-1", description: "Connected as @bot in Team" });
    assert.equal((await json(await route.GET())).body.connected, true);
    assert.deepEqual((await json(await route.DELETE())).body, { connected: false });
  `);
});

test("config route bounds routine settings", () => {
  runRoutes(`
    const route = await load("src/app/api/config/route.ts");
    const ok = await json(await route.PUT(jsonReq("/api/config", "PUT", { max_parallel_routines: 3, routine_storage_limit_mb: 2048 })));
    assert.equal(ok.body.max_parallel_routines, 3);
    assert.equal(ok.body.routine_storage_limit_mb, 2048);
    assert.equal((await route.PUT(jsonReq("/api/config", "PUT", { max_parallel_routines: 99 }))).status, 400);
  `);
});
