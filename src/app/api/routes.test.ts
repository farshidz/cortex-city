import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function createTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "app-routes-test-"));
}

function runRouteScript(workspace: string, body: string) {
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
          const routeUrl = (relativePath) =>
            new URL(relativePath, \`file://\${repoRoot}/\`).href;
          const loadRoute = async (relativePath) => {
            const imported = await import(routeUrl(relativePath));
            return imported.default || imported;
          };
          const { NextRequest } = await import("next/server");
          const request = (url, init = {}) => new NextRequest(url, init);
          const json = async (response) => ({
            status: response.status,
            body: await response.json(),
          });
          const writeJson = (filePath, value) => {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
          };
          const readJson = (filePath) =>
            JSON.parse(fs.readFileSync(filePath, "utf-8"));

          ${body}

          console.log(JSON.stringify({ ok: true }));
        })().catch((error) => {
          console.error(error);
          process.exit(1);
        });
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
        HOME: workspace,
      },
    }
  );

  return JSON.parse(output);
}

function runRouteAssertions(body: string) {
  const workspace = createTempWorkspace();
  assert.deepEqual(runRouteScript(workspace, body), { ok: true });
}

function withCortexState(body: string) {
  return `
      const cortexDir = path.join(workspace, ".cortex");
      const promptsDir = path.join(workspace, "prompts", "templates");
      const agentPromptDir = path.join(workspace, "prompts", "agents");
      const logsDir = path.join(workspace, "logs");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.mkdirSync(agentPromptDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      const config = {
        max_parallel_sessions: 3,
        poll_interval_seconds: 15,
        task_run_timeout_ms: 60000,
        default_permission_mode: "acceptEdits",
        default_agent_runner: "codex",
        default_claude_model: "claude-sonnet-4-6",
        default_claude_effort: "high",
        default_codex_model: "gpt-5.4",
        default_codex_effort: "medium",
        agents: {
          "cortex-city-swe": {
            name: "Cortex City SWE",
            repo_slug: "farshidz/cortex-city",
            prompt_file: "prompts/agents/cortex-city-swe.md",
            review_prompt_file: "prompts/agents/cortex-city-swe.review.md",
            cleanup_prompt_file: "prompts/agents/cortex-city-swe.cleanup.md",
            default_branch: "main",
          },
        },
      };
      const baseTask = {
        id: "task-1",
        title: "Open task",
        description: "Implement a feature",
        status: "open",
        agent: "cortex-city-swe",
        agent_runner: "codex",
        permission_mode: "acceptEdits",
        model: "gpt-5.4",
        effort: "medium",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
        run_count: 0,
      };
      const childTask = {
        ...baseTask,
        id: "child-1",
        title: "Child task",
        parent_task_id: "task-1",
        status: "in_review",
      };
      const activeTask = {
        ...baseTask,
        id: "active-1",
        title: "Active task",
        status: "in_progress",
        current_run_pid: process.pid,
        session_id: "active-session",
        last_run_at: "2026-05-01T00:05:00.000Z",
      };
      const blockedDeleteTask = {
        ...baseTask,
        id: "blocked-delete",
        title: "Blocked delete",
        status: "in_progress",
        current_run_pid: 12345,
      };
      writeJson(path.join(cortexDir, "config.json"), config);
      writeJson(path.join(cortexDir, "tasks.json"), [
        baseTask,
        childTask,
        activeTask,
        blockedDeleteTask,
      ]);
      fs.writeFileSync(path.join(promptsDir, "initial.md"), "Initial template");
      fs.writeFileSync(path.join(promptsDir, "review.md"), "Review template");
      fs.writeFileSync(path.join(agentPromptDir, "cortex-city-swe.md"), "Initial prompt");
      fs.writeFileSync(
        path.join(agentPromptDir, "cortex-city-swe.review.md"),
        "Review prompt"
      );
      fs.writeFileSync(
        path.join(agentPromptDir, ".env.cortex-city-swe"),
        [
          "# comment",
          "TOKEN=\\"secret=value\\"",
          "PLAIN=visible",
          "IGNORED_LINE",
          "",
        ].join("\\n")
      );

      ${body}
    `;
}

test("config route reads and updates Cortex config", () => {
  runRouteAssertions(
    withCortexState(`
      const configRoute = await loadRoute("./src/app/api/config/route.ts");
      assert.deepEqual((await json(await configRoute.GET())).body.agents, config.agents);
      const updatedConfig = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ max_parallel_sessions: 5 }),
          })
        )
      );
      assert.equal(updatedConfig.body.max_parallel_sessions, 5);
      assert.equal(readJson(path.join(cortexDir, "config.json")).max_parallel_sessions, 5);
    `)
  );
});

test("prompts route returns templates with missing cleanup fallback", () => {
  runRouteAssertions(
    withCortexState(`
      const promptsRoute = await loadRoute("./src/app/api/prompts/route.ts");
      const prompts = await json(await promptsRoute.GET());
      assert.deepEqual(prompts.body, {
        initial: "Initial template",
        review: "Review template",
        cleanup: "(template not found)",
      });
    `)
  );
});

test("agent env route reads, validates, and writes env files", () => {
  runRouteAssertions(
    withCortexState(`
      const agentEnvRoute = await loadRoute("./src/app/api/agents/[id]/env/route.ts");
      const missingEnv = await json(
        await agentEnvRoute.GET(request("http://localhost/api/agents/missing/env"), {
          params: Promise.resolve({ id: "missing" }),
        })
      );
      assert.equal(missingEnv.status, 404);

      const envBefore = await json(
        await agentEnvRoute.GET(
          request("http://localhost/api/agents/cortex-city-swe/env"),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.deepEqual(envBefore.body.vars, {
        TOKEN: "secret=value",
        PLAIN: "visible",
      });

      const envAfter = await json(
        await agentEnvRoute.PUT(
          request("http://localhost/api/agents/cortex-city-swe/env", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              vars: { TOKEN: "updated", "": "ignored", EXTRA: "value" },
            }),
          }),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.equal(envAfter.body.ok, true);
      assert.match(
        fs.readFileSync(path.join(agentPromptDir, ".env.cortex-city-swe"), "utf-8"),
        /TOKEN=updated\\nEXTRA=value\\n/
      );
    `)
  );
});

test("agent env route returns empty vars when env file is absent", () => {
  runRouteAssertions(
    withCortexState(`
      fs.rmSync(path.join(agentPromptDir, ".env.cortex-city-swe"));
      const agentEnvRoute = await loadRoute("./src/app/api/agents/[id]/env/route.ts");
      const response = await json(
        await agentEnvRoute.GET(
          request("http://localhost/api/agents/cortex-city-swe/env"),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.deepEqual(response.body.vars, {});
      assert.match(response.body.path, /\\.env\\.cortex-city-swe$/);
    `)
  );
});

test("agent prompt route reads configured modes and writes cleanup prompts", () => {
  runRouteAssertions(
    withCortexState(`
      const agentPromptRoute = await loadRoute(
        "./src/app/api/agents/[id]/prompt/route.ts"
      );
      const missingPrompt = await json(
        await agentPromptRoute.GET(
          request("http://localhost/api/agents/missing/prompt"),
          { params: Promise.resolve({ id: "missing" }) }
        )
      );
      assert.equal(missingPrompt.status, 404);

      const reviewPrompt = await json(
        await agentPromptRoute.GET(
          request("http://localhost/api/agents/cortex-city-swe/prompt?mode=review"),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.equal(reviewPrompt.body.content, "Review prompt");
      assert.equal(reviewPrompt.body.mode, "review");

      const cleanupPrompt = await json(
        await agentPromptRoute.PUT(
          request("http://localhost/api/agents/cortex-city-swe/prompt?mode=cleanup", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "Cleanup prompt" }),
          }),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.equal(cleanupPrompt.body.mode, "cleanup");
      assert.equal(
        fs.readFileSync(path.join(agentPromptDir, "cortex-city-swe.cleanup.md"), "utf-8"),
        "Cleanup prompt"
      );
    `)
  );
});

test("agent prompt route defaults to initial mode and returns empty missing files", () => {
  runRouteAssertions(
    withCortexState(`
      const agentPromptRoute = await loadRoute(
        "./src/app/api/agents/[id]/prompt/route.ts"
      );
      const initialPrompt = await json(
        await agentPromptRoute.GET(
          request("http://localhost/api/agents/cortex-city-swe/prompt"),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.equal(initialPrompt.body.mode, "initial");
      assert.equal(initialPrompt.body.content, "Initial prompt");

      const missingCleanupPrompt = await json(
        await agentPromptRoute.GET(
          request("http://localhost/api/agents/cortex-city-swe/prompt?mode=cleanup"),
          { params: Promise.resolve({ id: "cortex-city-swe" }) }
        )
      );
      assert.equal(missingCleanupPrompt.body.mode, "cleanup");
      assert.equal(missingCleanupPrompt.body.content, "");
    `)
  );
});

test("cortex git route reports disabled state outside cortex git repos", () => {
  runRouteAssertions(
    withCortexState(`
      const cortexGitRoute = await loadRoute("./src/app/api/cortex-git/route.ts");
      assert.deepEqual((await json(await cortexGitRoute.GET())).body, {
        enabled: false,
        pushing: false,
      });
    `)
  );
});

test("orchestrator route reports active sessions and disabled autostart", () => {
  runRouteAssertions(
    withCortexState(`
      writeJson(path.join(cortexDir, "config.json"), {
        ...config,
        max_parallel_sessions: 5,
      });
      const orchestratorRoute = await loadRoute("./src/app/api/orchestrator/route.ts");
      const orchestratorStatus = await json(await orchestratorRoute.GET());
      assert.equal(orchestratorStatus.body.max_sessions, 5);
      assert.equal(orchestratorStatus.body.active_sessions, 1);
      const orchestratorPost = await json(await orchestratorRoute.POST());
      assert.equal(orchestratorPost.body.ok, false);
    `)
  );
});

test("sessions route lists active tasks and validates start requests", () => {
  runRouteAssertions(
    withCortexState(`
      const sessionsRoute = await loadRoute("./src/app/api/sessions/route.ts");
      const sessions = await json(await sessionsRoute.GET());
      assert.equal(sessions.body.length, 1);
      assert.equal(sessions.body[0].task_id, "active-1");
      assert.equal(
        (await json(await sessionsRoute.POST(request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })))).status,
        400
      );
      assert.equal(
        (await json(await sessionsRoute.POST(request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task_id: "missing" }),
        })))).status,
        404
      );
    `)
  );
});

test("tasks route filters and creates tasks with normalized defaults", () => {
  runRouteAssertions(
    withCortexState(`
      const tasksRoute = await loadRoute("./src/app/api/tasks/route.ts");
      const allTasks = await json(
        await tasksRoute.GET(request("http://localhost/api/tasks"))
      );
      assert.equal(allTasks.body.length, 4);

      const openTasks = await json(
        await tasksRoute.GET(request("http://localhost/api/tasks?status=open"))
      );
      assert.equal(openTasks.body.length, 1);

      const createdTask = await json(
        await tasksRoute.POST(
          request("http://localhost/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "New task",
              description: "Created through the route",
              agent: "cortex-city-swe",
              agent_runner: "claude",
              permission_mode: "yolo",
              branch_name: "agent/new-task",
            }),
          })
        )
      );
      assert.equal(createdTask.status, 201);
      assert.equal(createdTask.body.status, "open");
      assert.equal(createdTask.body.agent_runner, "claude");
      assert.equal(createdTask.body.permission_mode, "acceptEdits");
      assert.equal(createdTask.body.model, "claude-sonnet-4-6");
    `)
  );
});

test("task detail route returns missing status and child summaries", () => {
  runRouteAssertions(
    withCortexState(`
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const missingTask = await json(
        await taskRoute.GET(request("http://localhost/api/tasks/missing"), {
          params: Promise.resolve({ id: "missing" }),
        })
      );
      assert.equal(missingTask.status, 404);

      const taskWithChildren = await json(
        await taskRoute.GET(request("http://localhost/api/tasks/task-1"), {
          params: Promise.resolve({ id: "task-1" }),
        })
      );
      assert.deepEqual(taskWithChildren.body.child_tasks, [
        {
          id: "child-1",
          title: "Child task",
          status: "in_review",
          agent: "cortex-city-swe",
        },
      ]);
    `)
  );
});

test("task detail route updates task metadata with normalized permissions", () => {
  runRouteAssertions(
    withCortexState(`
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const updatedTask = await json(
        await taskRoute.PUT(
          request("http://localhost/api/tasks/task-1", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent_runner: "claude",
              permission_mode: "yolo",
              status: "closed",
            }),
          }),
          { params: Promise.resolve({ id: "task-1" }) }
        )
      );
      assert.equal(updatedTask.body.status, "closed");
      assert.equal(updatedTask.body.permission_mode, "acceptEdits");
      assert.equal(
        (await json(await taskRoute.PUT(
          request("http://localhost/api/tasks/missing", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "closed" }),
          }),
          { params: Promise.resolve({ id: "missing" }) }
        ))).status,
        404
      );
    `)
  );
});

test("task detail route clears worktree paths when finalizing tasks", () => {
  runRouteAssertions(
    withCortexState(`
      writeJson(path.join(cortexDir, "tasks.json"), [
        baseTask,
        {
          ...baseTask,
          id: "worktree-task",
          title: "Worktree task",
          worktree_path: path.join(workspace, "missing-worktree"),
        },
      ]);
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const updatedTask = await json(
        await taskRoute.PUT(
          request("http://localhost/api/tasks/worktree-task", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "merged" }),
          }),
          { params: Promise.resolve({ id: "worktree-task" }) }
        )
      );
      assert.equal(updatedTask.status, 200);
      assert.equal(updatedTask.body.status, "merged");
      assert.equal("worktree_path" in updatedTask.body, false);
    `)
  );
});

test("task detail route guards running tasks and deletes removable tasks", () => {
  runRouteAssertions(
    withCortexState(`
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      assert.equal(
        (await json(await taskRoute.DELETE(
          request("http://localhost/api/tasks/blocked-delete", { method: "DELETE" }),
          { params: Promise.resolve({ id: "blocked-delete" }) }
        ))).status,
        409
      );
      assert.equal(
        (await json(await taskRoute.DELETE(
          request("http://localhost/api/tasks/child-1", { method: "DELETE" }),
          { params: Promise.resolve({ id: "child-1" }) }
        ))).body.ok,
        true
      );
      assert.equal(
        (await json(await taskRoute.DELETE(
          request("http://localhost/api/tasks/missing", { method: "DELETE" }),
          { params: Promise.resolve({ id: "missing" }) }
        ))).status,
        404
      );
    `)
  );
});

test("task detail route deletes tasks with stale worktree paths", () => {
  runRouteAssertions(
    withCortexState(`
      writeJson(path.join(cortexDir, "tasks.json"), [
        {
          ...baseTask,
          id: "stale-worktree-task",
          title: "Stale worktree task",
          worktree_path: path.join(workspace, "missing-worktree"),
        },
      ]);
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const deleted = await json(
        await taskRoute.DELETE(
          request("http://localhost/api/tasks/stale-worktree-task", {
            method: "DELETE",
          }),
          { params: Promise.resolve({ id: "stale-worktree-task" }) }
        )
      );
      assert.deepEqual(deleted.body, { ok: true });
    `)
  );
});

test("task instruction route rejects invalid manual instructions", () => {
  runRouteAssertions(
    withCortexState(`
      const instructionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/instruction/route.ts"
      );
      writeJson(path.join(cortexDir, "tasks.json"), [
        baseTask,
        { ...baseTask, id: "final-task", status: "merged" },
        { ...baseTask, id: "pending-task", pending_manual_instruction: "wait" },
      ]);
      assert.equal(
        (await json(await instructionRoute.POST(
          request("http://localhost/api/tasks/missing/instruction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ instruction: "continue" }),
          }),
          { params: Promise.resolve({ id: "missing" }) }
        ))).status,
        404
      );
      assert.equal(
        (await json(await instructionRoute.POST(
          request("http://localhost/api/tasks/final-task/instruction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ instruction: "continue" }),
          }),
          { params: Promise.resolve({ id: "final-task" }) }
        ))).status,
        409
      );
      assert.equal(
        (await json(await instructionRoute.POST(
          request("http://localhost/api/tasks/pending-task/instruction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ instruction: "continue" }),
          }),
          { params: Promise.resolve({ id: "pending-task" }) }
        ))).status,
        409
      );
      assert.equal(
        (await json(await instructionRoute.POST(
          request("http://localhost/api/tasks/task-1/instruction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "not json",
          }),
          { params: Promise.resolve({ id: "task-1" }) }
        ))).status,
        400
      );
    `)
  );
});

test("task instruction route records valid manual instructions", () => {
  runRouteAssertions(
    withCortexState(`
      const instructionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/instruction/route.ts"
      );
      writeJson(path.join(cortexDir, "tasks.json"), [
        baseTask,
        { ...baseTask, id: "final-task", status: "merged" },
        { ...baseTask, id: "pending-task", pending_manual_instruction: "wait" },
      ]);
      const instructed = await json(
        await instructionRoute.POST(
          request("http://localhost/api/tasks/task-1/instruction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ instruction: "  continue carefully  " }),
          }),
          { params: Promise.resolve({ id: "task-1" }) }
        )
      );
      assert.equal(instructed.body.pending_manual_instruction, "continue carefully");
    `)
  );
});

function withSessionState(body: string) {
  return `
      const cortexDir = path.join(workspace, ".cortex");
      const logsDir = path.join(workspace, "logs");
      const claudeProjectsDir = path.join(workspace, ".claude", "projects");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(claudeProjectsDir, { recursive: true });
      writeJson(path.join(cortexDir, "config.json"), {
        max_parallel_sessions: 2,
        poll_interval_seconds: 30,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "codex",
        agents: {},
      });

      const baseTask = {
        id: "task-codex",
        title: "Codex task",
        description: "Use codex",
        status: "in_progress",
        agent: "cortex-city-swe",
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      };
      const claudeWorktree = path.join(workspace, "worktrees", "claude-task");
      const projectId = claudeWorktree.replace(/^\\//, "").replace(/\\//g, "-");
      const claudeSessionId = "claude-session";
      fs.mkdirSync(path.join(claudeProjectsDir, projectId), { recursive: true });
      fs.writeFileSync(
        path.join(claudeProjectsDir, projectId, claudeSessionId + ".jsonl"),
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-05-01T00:01:00.000Z",
            message: { content: "Start work" },
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-05-01T00:02:00.000Z",
            message: {
              content: [
                { type: "text", text: "Follow up" },
                { type: "tool_result", content: "Tool output" },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-05-01T00:03:00.000Z",
            message: {
              content: [
                { type: "text", text: "Working" },
                { type: "tool_use", name: "Edit", input: { file: "route.ts" } },
              ],
            },
          }),
          "{not-json",
        ].join("\\n")
      );
      writeJson(path.join(cortexDir, "tasks.json"), [
        {
          ...baseTask,
          agent_runner: "codex",
          last_run_at: "2026-05-01T00:00:30.000Z",
        },
        {
          ...baseTask,
          id: "task-claude",
          title: "Claude task",
          agent_runner: "claude",
          session_id: claudeSessionId,
          worktree_path: claudeWorktree,
        },
        {
          ...baseTask,
          id: "task-empty",
          title: "Empty task",
          agent_runner: "claude",
        },
      ]);
      fs.writeFileSync(
        path.join(logsDir, "task-task-codex-001.jsonl"),
        [
          "--- Session started at 2026-05-01T00:00:30.000Z ---",
          JSON.stringify({
            type: "thread.started",
            thread_id: "codex-thread",
            received_at: "2026-05-01T00:00:31.000Z",
          }),
          JSON.stringify({
            type: "prompt",
            mode: "initial",
            content: "Build it",
            timestamp: "2026-05-01T00:00:32.000Z",
          }),
          JSON.stringify({
            type: "item.completed",
            timestamp: "2026-05-01T00:00:33.000Z",
            item: { type: "agent_message", text: "Done" },
          }),
          JSON.stringify({
            type: "item.completed",
            received_at: "2026-05-01T00:00:34.000Z",
            item: {
              type: "command_execution",
              command: "npm test",
              aggregated_output: "ok",
            },
          }),
          JSON.stringify({
            type: "error",
            message: "Something failed",
            received_at: "2026-05-01T00:00:35.000Z",
          }),
          "not-json",
        ].join("\\n")
      );

      ${body}
    `;
}

test("session route loads Codex log messages", () => {
  runRouteAssertions(
    withSessionState(`
      const sessionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/session/route.ts"
      );
      const codex = await json(
        await sessionRoute.GET(
          request("http://localhost/api/tasks/task-codex/session"),
          { params: Promise.resolve({ id: "task-codex" }) }
        )
      );
      assert.equal(codex.status, 200);
      assert.equal(codex.body.session_id, "codex-thread");
      assert.equal(codex.body.agent_runner, "codex");
      assert.equal(codex.body.message_count, 4);
      assert.match(codex.body.messages[2].content, /Ran command: npm test/);
    `)
  );
});

test("session route loads Claude session files", () => {
  runRouteAssertions(
    withSessionState(`
      const sessionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/session/route.ts"
      );
      const claude = await json(
        await sessionRoute.GET(
          request("http://localhost/api/tasks/task-claude/session"),
          { params: Promise.resolve({ id: "task-claude" }) }
        )
      );
      assert.equal(claude.status, 200);
      assert.equal(claude.body.session_id, claudeSessionId);
      assert.equal(claude.body.message_count, 3);
      assert.deepEqual(claude.body.messages[2].tool_calls, [
        {
          name: "Edit",
          input: JSON.stringify({ file: "route.ts" }, null, 2),
        },
      ]);
    `)
  );
});

test("session route finds Claude sessions without a worktree path", () => {
  runRouteAssertions(
    withSessionState(`
      const fallbackProjectDir = path.join(claudeProjectsDir, "fallback-project");
      fs.mkdirSync(fallbackProjectDir, { recursive: true });
      fs.writeFileSync(
        path.join(fallbackProjectDir, "fallback-session.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-01T00:04:00.000Z",
          message: { content: [{ type: "text", text: "Fallback found" }] },
        }) + "\\n"
      );
      const tasks = readJson(path.join(cortexDir, "tasks.json"));
      writeJson(path.join(cortexDir, "tasks.json"), [
        ...tasks,
        {
          ...baseTask,
          id: "task-claude-fallback",
          title: "Fallback Claude task",
          agent_runner: "claude",
          session_id: "fallback-session",
        },
      ]);

      const sessionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/session/route.ts"
      );
      const response = await json(
        await sessionRoute.GET(
          request("http://localhost/api/tasks/task-claude-fallback/session"),
          { params: Promise.resolve({ id: "task-claude-fallback" }) }
        )
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.messages[0].content, "Fallback found");
    `)
  );
});

test("session route adds task context when Codex logs omit user messages", () => {
  runRouteAssertions(
    withSessionState(`
      const tasks = readJson(path.join(cortexDir, "tasks.json"));
      writeJson(path.join(cortexDir, "tasks.json"), [
        ...tasks,
        {
          ...baseTask,
          id: "task-codex-fallback",
          title: "Codex fallback task",
          description: "",
          agent_runner: "codex",
          session_id: "saved-session",
          last_run_at: "2026-05-01T00:10:00.000Z",
        },
      ]);
      fs.writeFileSync(
        path.join(logsDir, "task-task-codex-fallback-001.jsonl"),
        [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Only assistant output" },
          }),
        ].join("\\n")
      );

      const sessionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/session/route.ts"
      );
      const response = await json(
        await sessionRoute.GET(
          request("http://localhost/api/tasks/task-codex-fallback/session"),
          { params: Promise.resolve({ id: "task-codex-fallback" }) }
        )
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.session_id, "saved-session");
      assert.equal(response.body.messages[0].role, "user");
      assert.equal(
        response.body.messages[0].content,
        "Task description unavailable. See task page for details."
      );
    `)
  );
});

test("session route returns not found for missing session data", () => {
  runRouteAssertions(
    withSessionState(`
      const sessionRoute = await loadRoute(
        "./src/app/api/tasks/[id]/session/route.ts"
      );
      assert.equal(
        (await json(await sessionRoute.GET(
          request("http://localhost/api/tasks/task-empty/session"),
          { params: Promise.resolve({ id: "task-empty" }) }
        ))).status,
        404
      );
      assert.equal(
        (await json(await sessionRoute.GET(
          request("http://localhost/api/tasks/missing/session"),
          { params: Promise.resolve({ id: "missing" }) }
        ))).status,
        404
      );
    `)
  );
});

function withReviewState(body: string) {
  return `
      const cortexDir = path.join(workspace, ".cortex");
      const binDir = path.join(workspace, "bin");
      fs.mkdirSync(cortexDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      process.env.PATH = binDir + ":" + (process.env.PATH || "");

      const prUrl = "https://github.com/acme/widget/pull/1";
      const staleUrl = "https://github.com/acme/widget/pull/2";
      writeJson(path.join(cortexDir, "config.json"), {
        max_parallel_sessions: 2,
        poll_interval_seconds: 30,
        default_permission_mode: "bypassPermissions",
        default_agent_runner: "codex",
        agents: {},
      });
      writeJson(path.join(cortexDir, "reviews.json"), {
        [staleUrl]: {
          pr_url: staleUrl,
          pr_number: 2,
          repo_slug: "acme/widget",
          title: "Older review",
          author: "octocat",
          head_sha: "def456",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
          summary: "older",
          generated_at: "2026-05-01T00:00:00.000Z",
          review_state: "needs_approval",
        },
        [prUrl]: {
          pr_url: prUrl,
          pr_number: 1,
          repo_slug: "acme/widget",
          title: "Newer review",
          author: "octocat",
          head_sha: "abc123",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:00.000Z",
          summary: "current summary",
          generated_at: "2026-05-02T00:00:00.000Z",
          review_state: "needs_approval",
          followups: [
            {
              asked_at: "2026-05-02T00:01:00.000Z",
              question: "What changed?",
              answered_at: "2026-05-02T00:02:00.000Z",
              answer: "Tests changed.",
              resumed: false,
            },
          ],
        },
        "https://github.com/acme/widget/pull/3": {
          pr_url: "https://github.com/acme/widget/pull/3",
          pr_number: 3,
          repo_slug: "acme/widget",
          title: "Running review",
          author: "octocat",
          head_sha: "ghi789",
          created_at: "2026-05-03T00:00:00.000Z",
          updated_at: "2026-05-03T00:00:00.000Z",
          summary: "",
          generated_at: "",
          review_state: "needs_approval",
          current_run_pid: 12345,
        },
      });
      fs.writeFileSync(
        path.join(binDir, "gh"),
        [
          "#!/usr/bin/env node",
          "const { appendFileSync } = require('node:fs');",
          "if (process.env.FAKE_GH_CALLS_FILE) appendFileSync(process.env.FAKE_GH_CALLS_FILE, process.argv.slice(2).join(' ') + '\\\\n');",
          "process.exit(0);",
          "",
        ].join("\\n"),
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(binDir, "codex"),
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'review-session' }) + '\\\\n');",
          "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fresh summary' } }) + '\\\\n');",
          "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } }) + '\\\\n');",
          "process.exit(0);",
          "",
        ].join("\\n"),
        { mode: 0o755 }
      );
      process.env.FAKE_GH_CALLS_FILE = path.join(workspace, "gh-calls.log");

      ${body}
    `;
}

test("reviews route lists cached reviews by recency", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsRoute = await loadRoute("./src/app/api/reviews/route.ts");
      const reviews = await json(await reviewsRoute.GET());
      assert.equal(reviews.body[0].pr_url, "https://github.com/acme/widget/pull/3");
      assert.equal(reviews.body[1].pr_url, prUrl);
      assert.equal(reviews.body[2].pr_url, staleUrl);
    `)
  );
});

test("review followup route reads existing followups", () => {
  runRouteAssertions(
    withReviewState(`
      const followupRoute = await loadRoute("./src/app/api/reviews/followup/route.ts");
      assert.equal(
        (await json(await followupRoute.GET(
          request("http://localhost/api/reviews/followup")
        ))).status,
        400
      );
      assert.deepEqual(
        (await json(await followupRoute.GET(
          request("http://localhost/api/reviews/followup?pr_url=https%3A%2F%2Fgithub.com%2Facme%2Fwidget%2Fpull%2F99")
        ))).body,
        { followups: [] }
      );
      const followups = await json(
        await followupRoute.GET(
          request("http://localhost/api/reviews/followup?pr_url=" + encodeURIComponent(prUrl))
        )
      );
      assert.equal(followups.body.followups[0].answer, "Tests changed.");
    `)
  );
});

test("review followup route validates followup requests", () => {
  runRouteAssertions(
    withReviewState(`
      const followupRoute = await loadRoute("./src/app/api/reviews/followup/route.ts");
      assert.equal(
        (await json(await followupRoute.POST(
          request("http://localhost/api/reviews/followup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ question: "Missing URL" }),
          })
        ))).status,
        400
      );
      assert.equal(
        (await json(await followupRoute.POST(
          request("http://localhost/api/reviews/followup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pr_url: prUrl, question: "   " }),
          })
        ))).status,
        400
      );
      assert.equal(
        (await json(await followupRoute.POST(
          request("http://localhost/api/reviews/followup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pr_url: "https://github.com/acme/widget/pull/99",
              question: "Anything else?",
            }),
          })
        ))).status,
        400
      );
    `)
  );
});

test("review submit route validates review submissions", () => {
  runRouteAssertions(
    withReviewState(`
      const submitRoute = await loadRoute("./src/app/api/reviews/submit/route.ts");
      assert.equal(
        (await json(await submitRoute.POST(
          request("http://localhost/api/reviews/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          })
        ))).status,
        400
      );
      assert.equal(
        (await json(await submitRoute.POST(
          request("http://localhost/api/reviews/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pr_url: prUrl, decision: "invalid" }),
          })
        ))).status,
        400
      );
      assert.equal(
        (await json(await submitRoute.POST(
          request("http://localhost/api/reviews/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pr_url: prUrl, decision: "comment", body: "   " }),
          })
        ))).status,
        500
      );
    `)
  );
});

test("review submit route invokes gh for valid submissions", () => {
  runRouteAssertions(
    withReviewState(`
      const submitRoute = await loadRoute("./src/app/api/reviews/submit/route.ts");
      const submitted = await json(
        await submitRoute.POST(
          request("http://localhost/api/reviews/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pr_url: prUrl, decision: "approve", body: "LGTM" }),
          })
        )
      );
      assert.deepEqual(submitted.body, { ok: true });
      assert.match(
        fs.readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf-8"),
        /pr review https:\\/\\/github.com\\/acme\\/widget\\/pull\\/1 --approve --body LGTM/
      );
    `)
  );
});

test("review summarize route validates cached review state", () => {
  runRouteAssertions(
    withReviewState(`
      const summarizeRoute = await loadRoute("./src/app/api/reviews/summarize/route.ts");
      assert.equal(
        (await json(await summarizeRoute.POST(
          request("http://localhost/api/reviews/summarize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ))).status,
        400
      );
      assert.equal(
        (await json(await summarizeRoute.POST(
          request("http://localhost/api/reviews/summarize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pr_url: "https://github.com/acme/widget/pull/99",
            }),
          })
        ))).status,
        404
      );
      assert.equal(
        (await json(await summarizeRoute.POST(
          request("http://localhost/api/reviews/summarize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pr_url: "https://github.com/acme/widget/pull/3",
            }),
          })
        ))).status,
        409
      );
    `)
  );
});

test("review summarize route launches Codex summaries with overrides", () => {
  runRouteAssertions(
    withReviewState(`
      const summarizeRoute = await loadRoute("./src/app/api/reviews/summarize/route.ts");
      const summarized = await json(
        await summarizeRoute.POST(
          request("http://localhost/api/reviews/summarize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pr_url: prUrl,
              runtime: "codex",
              effort: "high",
              model: "gpt-test",
            }),
          })
        )
      );
      assert.equal(summarized.status, 200);
      assert.equal(summarized.body.summary, "Fresh summary");
      assert.equal(summarized.body.runtime, "codex");
      assert.equal(summarized.body.effort, "high");
      assert.equal(summarized.body.model, "gpt-test");
      assert.equal(summarized.body.session_id, "review-session");
    `)
  );
});
