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

test("config route persists and clears reviewer model overrides safely", () => {
  runRouteAssertions(
    withCortexState(`
      const configRoute = await loadRoute("./src/app/api/config/route.ts");
      const configPath = path.join(cortexDir, "config.json");

      const customModel = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ review_model: "  gpt-5.6-custom  " }),
          })
        )
      );
      assert.equal(customModel.body.review_model, "gpt-5.6-custom");
      assert.equal(readJson(configPath).review_model, "gpt-5.6-custom");

      const clearedModel = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ review_model: "   " }),
          })
        )
      );
      assert.equal("review_model" in clearedModel.body, false);
      assert.equal("review_model" in readJson(configPath), false);

      await configRoute.PUT(
        request("http://localhost/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            review_model: "gpt-5.6",
            review_effort: "xhigh",
          }),
        })
      );
      const clearedNullModel = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ review_model: null }),
          })
        )
      );
      assert.equal("review_model" in clearedNullModel.body, false);
      assert.equal("review_model" in readJson(configPath), false);

      await configRoute.PUT(
        request("http://localhost/api/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ review_model: "gpt-5.6" }),
        })
      );
      const changedInheritedRuntime = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ default_agent_runner: "claude" }),
          })
        )
      );
      assert.equal("review_model" in changedInheritedRuntime.body, false);
      assert.equal("review_model" in readJson(configPath), false);
      assert.equal("review_effort" in changedInheritedRuntime.body, false);
      assert.equal("review_effort" in readJson(configPath), false);

      const changedWithExplicitModel = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              review_runtime: "codex",
              review_model: "vendor/another-model",
            }),
          })
        )
      );
      assert.equal(
        changedWithExplicitModel.body.review_model,
        "vendor/another-model"
      );

      const changedReviewRuntime = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ review_runtime: "claude" }),
          })
        )
      );
      assert.equal("review_model" in changedReviewRuntime.body, false);
      assert.equal("review_model" in readJson(configPath), false);

      const clearedProfile = await json(
        await configRoute.PUT(
          request("http://localhost/api/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              default_claude_model: null,
              default_claude_effort: null,
              default_codex_model: null,
              default_codex_effort: null,
              review_prompt: null,
              reviewer_agent_prompt: null,
              review_effort: null,
              review_model: null,
            }),
          })
        )
      );
      for (const key of [
        "default_claude_model",
        "default_claude_effort",
        "default_codex_model",
        "default_codex_effort",
        "review_prompt",
        "reviewer_agent_prompt",
        "review_effort",
        "review_model",
      ]) {
        assert.equal(key in clearedProfile.body, false, key);
        assert.equal(key in readJson(configPath), false, key);
      }
    `)
  );
});

test("review learnings route reads and writes the learnings file", () => {
  runRouteAssertions(
    withCortexState(`
      const learningsRoute = await loadRoute("./src/app/api/reviews/learnings/route.ts");
      fs.writeFileSync(
        path.join(cortexDir, "review-learnings.md"),
        "# Review learnings\\n"
      );
      const initial = await json(await learningsRoute.GET());
      assert.deepEqual(initial.body, {
        content: "# Review learnings\\n",
        enabled: true,
      });

      const updated = await json(
        await learningsRoute.PUT(
          request("http://localhost/api/reviews/learnings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "- Manual lesson\\n" }),
          })
        )
      );
      assert.deepEqual(updated.body, {
        content: "- Manual lesson\\n",
        enabled: true,
      });
      assert.equal(
        fs.readFileSync(path.join(cortexDir, "review-learnings.md"), "utf-8"),
        "- Manual lesson\\n"
      );
    `)
  );
});

test("review learnings route rejects malformed content", () => {
  runRouteAssertions(
    withCortexState(`
      const learningsRoute = await loadRoute("./src/app/api/reviews/learnings/route.ts");
      fs.writeFileSync(
        path.join(cortexDir, "review-learnings.md"),
        "# Keep me\\n"
      );

      const missing = await json(
        await learningsRoute.PUT(
          request("http://localhost/api/reviews/learnings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        )
      );

      assert.equal(missing.status, 400);
      assert.deepEqual(missing.body, {
        error: "content must be a string",
      });
      assert.equal(
        fs.readFileSync(path.join(cortexDir, "review-learnings.md"), "utf-8"),
        "# Keep me\\n"
      );

      const numeric = await json(
        await learningsRoute.PUT(
          request("http://localhost/api/reviews/learnings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: 123 }),
          })
        )
      );

      assert.equal(numeric.status, 400);
      assert.deepEqual(numeric.body, {
        error: "content must be a string",
      });
      assert.equal(
        fs.readFileSync(path.join(cortexDir, "review-learnings.md"), "utf-8"),
        "# Keep me\\n"
      );

      const cleared = await json(
        await learningsRoute.PUT(
          request("http://localhost/api/reviews/learnings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "" }),
          })
        )
      );

      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.content, "");
      assert.equal(
        fs.readFileSync(path.join(cortexDir, "review-learnings.md"), "utf-8"),
        ""
      );
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
        orphanedWorktreeCount: 0,
        orphanedWorktrees: [],
        worktreeScanErrors: [],
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

test("agent status route reports unavailable CLIs without failing the request", () => {
  runRouteAssertions(`
    process.env.PATH = "";
    process.env.CLAUDE_CONFIG_DIR = path.join(workspace, "missing-claude-config");
    const agentStatusRoute = await loadRoute("./src/app/api/agent-status/route.ts");
    const response = await json(await agentStatusRoute.GET());
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map((status) => status.runtime), ["codex", "claude"]);
    assert.deepEqual(response.body.map((status) => status.state), [
      "unavailable",
      "unavailable",
    ]);
  `);
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
      assert.equal(createdTask.body.reviewer_agent_enabled, true);
      assert.equal(createdTask.body.model, "claude-sonnet-4-6");
    `)
  );
});

test("task detail route returns missing status and child summaries", () => {
  runRouteAssertions(
    withCortexState(`
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const taskPrUrl = "https://github.com/acme/widget/pull/77";
      const tasksPath = path.join(cortexDir, "tasks.json");
      const seededTasks = readJson(tasksPath);
      seededTasks[0] = {
        ...seededTasks[0],
        status: "in_review",
        pr_url: taskPrUrl,
      };
      writeJson(tasksPath, seededTasks);
      writeJson(path.join(cortexDir, "reviews.json"), {
        [taskPrUrl]: {
          source: "task",
          task_id: "task-1",
          pr_url: taskPrUrl,
          pr_number: 77,
          repo_slug: "acme/widget",
          title: "Open task",
          author: "owner",
          head_sha: "head-77",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:10:00.000Z",
          summary: "",
          generated_at: "",
          error: "Unsupported reviewer model",
          error_at: "2026-05-01T00:11:00.000Z",
        },
      });
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
      assert.equal(
        taskWithChildren.body.automatic_review_error,
        "Unsupported reviewer model"
      );
      assert.equal(
        taskWithChildren.body.automatic_review_error_at,
        "2026-05-01T00:11:00.000Z"
      );
    `)
  );
});

test("task detail route exposes task-owned automatic review results", () => {
  runRouteAssertions(
    withCortexState(`
      const taskRoute = await loadRoute("./src/app/api/tasks/[id]/route.ts");
      const taskPrUrl = "https://github.com/acme/widget/pull/78";
      const tasksPath = path.join(cortexDir, "tasks.json");
      const seededTasks = readJson(tasksPath);
      seededTasks[0] = {
        ...seededTasks[0],
        status: "in_review",
        pr_url: taskPrUrl,
      };
      writeJson(tasksPath, seededTasks);
      writeJson(path.join(cortexDir, "reviews.json"), {
        [taskPrUrl]: {
          source: "task",
          task_id: "task-1",
          pr_url: taskPrUrl,
          pr_number: 78,
          repo_slug: "acme/widget",
          title: "Open task",
          author: "owner",
          head_sha: "head-78",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:10:00.000Z",
          summary: "  ## Summary\\nA human decision is needed.  ",
          summary_head_sha: "head-78",
          generated_at: "2026-05-01T00:11:00.000Z",
          agent_review_status: "needs_human_decision",
        },
      });

      const response = await json(
        await taskRoute.GET(request("http://localhost/api/tasks/task-1"), {
          params: Promise.resolve({ id: "task-1" }),
        })
      );

      assert.equal(response.status, 200);
      assert.deepEqual(response.body.automatic_review, {
        state: "needs_decision",
        status: "needs_human_decision",
        summary: "## Summary\\nA human decision is needed.",
        generated_at: "2026-05-01T00:11:00.000Z",
        head_sha: "head-78",
        summary_head_sha: "head-78",
      });
      assert.equal(response.body.automatic_review_error, undefined);
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
              reviewer_agent_enabled: false,
              status: "closed",
            }),
          }),
          { params: Promise.resolve({ id: "task-1" }) }
        )
      );
      assert.equal(updatedTask.body.status, "closed");
      assert.equal(updatedTask.body.permission_mode, "acceptEdits");
      assert.equal(updatedTask.body.reviewer_agent_enabled, false);
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
      const runningUrl = "https://github.com/acme/widget/pull/3";
      const needsReviewUrl = "https://github.com/acme/widget/pull/4";
      const finalUrl = "https://github.com/acme/widget/pull/5";
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
          my_last_review_sha: "old-sha",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
          summary: "older",
          summary_head_sha: "old-summary-sha",
          generated_at: "2026-05-01T00:00:00.000Z",
        },
        [prUrl]: {
          pr_url: prUrl,
          pr_number: 1,
          repo_slug: "acme/widget",
          title: "Newer review",
          author: "octocat",
          head_sha: "abc123",
          my_last_review_sha: "abc123",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:00.000Z",
          summary: "current summary",
          generated_at: "2026-05-02T00:00:00.000Z",
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
        [runningUrl]: {
          pr_url: runningUrl,
          pr_number: 3,
          repo_slug: "acme/widget",
          title: "Running review",
          author: "octocat",
          head_sha: "ghi789",
          created_at: "2026-05-03T00:00:00.000Z",
          updated_at: "2026-05-05T00:00:00.000Z",
          summary: "",
          generated_at: "",
          current_run_pid: 12345,
        },
        [needsReviewUrl]: {
          pr_url: needsReviewUrl,
          pr_number: 4,
          repo_slug: "acme/widget",
          title: "Needs review",
          author: "octocat",
          head_sha: "jkl012",
          created_at: "2026-05-04T00:00:00.000Z",
          updated_at: "2026-05-04T00:00:00.000Z",
          summary: "ready",
          generated_at: "2026-05-04T00:00:00.000Z",
        },
        [finalUrl]: {
          pr_url: finalUrl,
          pr_number: 5,
          repo_slug: "acme/widget",
          title: "Final review",
          author: "octocat",
          head_sha: "mno345",
          created_at: "2026-05-06T00:00:00.000Z",
          updated_at: "2026-05-06T00:00:00.000Z",
          summary: "done",
          generated_at: "2026-05-06T00:00:00.000Z",
          final_at: "2026-05-06T00:01:00.000Z",
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

test("reviews route lists cached reviews by merged state group then recency", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsRoute = await loadRoute("./src/app/api/reviews/route.ts");
      const reviews = await json(await reviewsRoute.GET());
      // Group 0 (needs_review), then group 1 by recency desc (running 05-05
      // before stale 05-01), then group 2 (reviewed), then group 3 (archived).
      assert.deepEqual(reviews.body.map((review) => review.pr_url), [
        needsReviewUrl,
        runningUrl,
        staleUrl,
        prUrl,
        finalUrl,
      ]);
      assert.deepEqual(reviews.body.map((review) => review.review_state), [
        "needs_review",
        "generating",
        "re_reviewing",
        "reviewed",
        "archived",
      ]);
    `)
  );
});

test("reviews route excludes persisted and newly claimed task-owned review records", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = readJson(reviewsPath);
      const taskReviewUrl = "https://github.com/acme/widget/pull/6";
      const newlyClaimedUrl = "https://github.com/acme/widget/pull/7";
      seeded[taskReviewUrl] = {
        ...seeded[needsReviewUrl],
        source: "task",
        task_id: "task-1",
        pr_url: taskReviewUrl,
        pr_number: 6,
        title: "Task-owned review",
      };
      seeded[newlyClaimedUrl] = {
        ...seeded[needsReviewUrl],
        source: "inbound",
        pr_url: newlyClaimedUrl,
        pr_number: 7,
        title: "Cached before task ownership",
      };
      writeJson(reviewsPath, seeded);
      writeJson(path.join(cortexDir, "tasks.json"), [
        {
          id: "task-7",
          title: "Live task owner",
          description: "Own the previously inbound PR",
          status: "in_review",
          agent: "cortex-city-swe",
          pr_url: newlyClaimedUrl,
          created_at: "2026-05-06T00:00:00.000Z",
          updated_at: "2026-05-06T00:01:00.000Z",
        },
      ]);

      const reviewsRoute = await loadRoute("./src/app/api/reviews/route.ts");
      const reviews = await json(await reviewsRoute.GET());
      assert.equal(reviews.status, 200);
      assert.equal(
        reviews.body.some((review) => review.pr_url === taskReviewUrl),
        false
      );
      assert.equal(
        reviews.body.some((review) => review.pr_url === newlyClaimedUrl),
        false
      );
      assert.equal(
        reviews.body.some((review) => review.pr_url === needsReviewUrl),
        true
      );
      assert.equal(reviews.body.every((review) => review.source !== "task"), true);
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

test("review followup route allows stale cached summaries", () => {
  runRouteAssertions(
    withReviewState(`
      const followupRoute = await loadRoute("./src/app/api/reviews/followup/route.ts");
      const response = await json(
        await followupRoute.POST(
          request("http://localhost/api/reviews/followup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pr_url: staleUrl,
              question: "Can I still ask?",
            }),
          })
        )
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.answer, "Fresh summary");
      assert.equal(response.body.resumed, false);

      const stored = readJson(path.join(cortexDir, "reviews.json"))[staleUrl];
      assert.equal(stored.followups.at(-1).question, "Can I still ask?");
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

test("review submit route rejects owner decisions for persisted and newly claimed task reviews", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = readJson(reviewsPath);
      const taskReviewUrl = "https://github.com/acme/widget/pull/6";
      const newlyClaimedUrl = "https://github.com/acme/widget/pull/7";
      seeded[taskReviewUrl] = {
        ...seeded[prUrl],
        source: "task",
        task_id: "task-1",
        pr_url: taskReviewUrl,
        pr_number: 6,
        title: "Task-owned review",
      };
      seeded[newlyClaimedUrl] = {
        ...seeded[prUrl],
        source: "inbound",
        pr_url: newlyClaimedUrl,
        pr_number: 7,
        title: "Cached before task ownership",
      };
      writeJson(reviewsPath, seeded);
      writeJson(path.join(cortexDir, "tasks.json"), [
        {
          id: "task-7",
          title: "Live task owner",
          description: "Own the previously inbound PR",
          status: "in_review",
          agent: "cortex-city-swe",
          pr_url: newlyClaimedUrl,
          created_at: "2026-05-06T00:00:00.000Z",
          updated_at: "2026-05-06T00:01:00.000Z",
        },
      ]);
      fs.writeFileSync(process.env.FAKE_GH_CALLS_FILE, "");

      const submitRoute = await loadRoute("./src/app/api/reviews/submit/route.ts");
      for (const ownedUrl of [taskReviewUrl, newlyClaimedUrl]) {
        for (const decision of ["approve", "request-changes"]) {
          const response = await json(
            await submitRoute.POST(
              request("http://localhost/api/reviews/submit", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  pr_url: ownedUrl,
                  decision,
                  body: decision === "approve" ? "LGTM" : "Please fix this",
                }),
              })
            )
          );
          assert.equal(response.status, 400);
          assert.match(response.body.error, /task-owned pull requests/i);
        }
      }

      for (const bypassUrl of [
        taskReviewUrl + "/",
        taskReviewUrl + "?attempt=bypass",
        "https://github.com/acme/widget/pull/999",
      ]) {
        const response = await json(
          await submitRoute.POST(
            request("http://localhost/api/reviews/submit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                pr_url: bypassUrl,
                decision: "approve",
                body: "LGTM",
              }),
            })
          )
        );
        assert.equal(response.status, 404);
        assert.match(response.body.error, /not cached as an inbound review/i);
      }

      assert.equal(
        fs.readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf-8"),
        ""
      );
    `)
  );
});

test("review submit route rejects owner decisions for self-authored labeled reviews", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = readJson(reviewsPath);
      const selfAuthoredUrl = "https://github.com/acme/widget/pull/8";
      seeded[selfAuthoredUrl] = {
        ...seeded[prUrl],
        source: "inbound",
        label_only: true,
        self_authored: true,
        pr_url: selfAuthoredUrl,
        pr_number: 8,
        title: "Self-authored labeled review",
        author: "me",
      };
      writeJson(reviewsPath, seeded);
      fs.writeFileSync(process.env.FAKE_GH_CALLS_FILE, "");

      const submitRoute = await loadRoute("./src/app/api/reviews/submit/route.ts");
      for (const decision of ["approve", "request-changes"]) {
        const response = await json(
          await submitRoute.POST(
            request("http://localhost/api/reviews/submit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                pr_url: selfAuthoredUrl,
                decision,
                body: decision === "approve" ? "LGTM" : "Please fix this",
              }),
            })
          )
        );
        assert.equal(response.status, 400);
        assert.match(response.body.error, /self-authored pull requests/i);
      }

      assert.equal(
        fs.readFileSync(process.env.FAKE_GH_CALLS_FILE, "utf-8"),
        ""
      );
    `)
  );
});

test("review submit route flips an approved PR out of the agent verdict state", () => {
  runRouteAssertions(
    withReviewState(`
      // Seed an open agent verdict so the row currently reads "needs your decision".
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = JSON.parse(fs.readFileSync(reviewsPath, "utf-8"));
      seeded[prUrl].agent_review_status = "needs_human_decision";
      fs.writeFileSync(reviewsPath, JSON.stringify(seeded));

      const reviewsRoute = await loadRoute("./src/app/api/reviews/route.ts");
      const before = (await json(await reviewsRoute.GET())).body.find(
        (review) => review.pr_url === prUrl
      );
      assert.equal(before.review_state, "needs_decision");

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

      // Approving the current head sets the approval signal and overrides the verdict.
      const after = (await json(await reviewsRoute.GET())).body.find(
        (review) => review.pr_url === prUrl
      );
      assert.equal(after.my_approval_sha, "abc123");
      assert.equal(after.review_state, "approved");
    `)
  );
});

test("review submit route clears the approval signal on request-changes", () => {
  runRouteAssertions(
    withReviewState(`
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = JSON.parse(fs.readFileSync(reviewsPath, "utf-8"));
      // A stale agent verdict that must not survive a human "request changes".
      seeded[prUrl].my_approval_sha = "abc123";
      seeded[prUrl].agent_review_status = "ready_for_human_approval";
      fs.writeFileSync(reviewsPath, JSON.stringify(seeded));

      const submitRoute = await loadRoute("./src/app/api/reviews/submit/route.ts");
      await submitRoute.POST(
        request("http://localhost/api/reviews/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pr_url: prUrl, decision: "request-changes", body: "Please fix" }),
        })
      );

      const reviewsRoute = await loadRoute("./src/app/api/reviews/route.ts");
      const after = (await json(await reviewsRoute.GET())).body.find(
        (review) => review.pr_url === prUrl
      );
      assert.equal(after.my_approval_sha, undefined);
      // Requesting changes sets the change-request signal at the current head,
      // which supersedes the stale verdict: the row shows "changes_requested",
      // not the agent's "ready_to_approve".
      assert.equal(after.my_changes_requested_sha, "abc123");
      assert.equal(after.review_state, "changes_requested");
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
      const reviewsPath = path.join(cortexDir, "reviews.json");
      const seeded = readJson(reviewsPath);
      seeded[prUrl].label_only = true;
      seeded[prUrl].self_authored = true;
      writeJson(reviewsPath, seeded);

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
      assert.equal(summarized.body.my_last_review_sha, "abc123");
      assert.equal(summarized.body.label_only, true);
      assert.equal(summarized.body.self_authored, true);
    `)
  );
});

test("issues route creates, lists, paginates, and filters resolved", () => {
  runRouteAssertions(
    withCortexState(`
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");

      const create = (title, plan) =>
        issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, description: title + " desc", plan }),
          })
        );

      const a = (await json(await create("Alpha"))).body;
      const b = (await json(await create("Beta", "## Plan"))).body;
      const c = (await json(await create("Gamma"))).body;
      assert.equal(typeof a.id, "string");
      assert.equal(b.plan, "## Plan");

      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );
      await issueDetailRoute.PUT(
        request("http://localhost/api/issues/" + c.id, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "closed" }),
        }),
        { params: Promise.resolve({ id: c.id }) }
      );

      const defaultList = (await json(
        await issuesRoute.GET(request("http://localhost/api/issues"))
      )).body;
      assert.equal(defaultList.total, 2);
      assert.equal(defaultList.items.length, 2);

      const resolvedList = (await json(
        await issuesRoute.GET(
          request("http://localhost/api/issues?show_resolved=true")
        )
      )).body;
      assert.equal(resolvedList.total, 3);

      const page1 = (await json(
        await issuesRoute.GET(
          request("http://localhost/api/issues?show_resolved=true&page=1&page_size=2")
        )
      )).body;
      assert.equal(page1.items.length, 2);
      assert.equal(page1.page, 1);
      assert.equal(page1.page_size, 2);

      const page2 = (await json(
        await issuesRoute.GET(
          request("http://localhost/api/issues?show_resolved=true&page=2&page_size=2")
        )
      )).body;
      assert.equal(page2.items.length, 1);
      assert.equal(page2.page, 2);
    `)
  );
});

test("issues comments route appends comments and bumps updated_at", () => {
  runRouteAssertions(
    withCortexState(`
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const commentsRoute = await loadRoute(
        "./src/app/api/issues/[id]/comments/route.ts"
      );
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );

      const created = (await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "I", description: "" }),
          })
        )
      )).body;

      const empty = (await json(
        await commentsRoute.POST(
          request("http://localhost/api/issues/" + created.id + "/comments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "   " }),
          }),
          { params: Promise.resolve({ id: created.id }) }
        )
      ));
      assert.equal(empty.status, 400);

      const comment = (await json(
        await commentsRoute.POST(
          request("http://localhost/api/issues/" + created.id + "/comments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "Hello" }),
          }),
          { params: Promise.resolve({ id: created.id }) }
        )
      )).body;
      assert.equal(comment.body, "Hello");

      const detail = (await json(
        await issueDetailRoute.GET(
          request("http://localhost/api/issues/" + created.id),
          { params: Promise.resolve({ id: created.id }) }
        )
      )).body;
      assert.equal(detail.comments.length, 1);
    `)
  );
});

test("issue delete returns 409 when a task is linked", () => {
  runRouteAssertions(
    withCortexState(`
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );
      const issueStoreImported = await import(
        new URL("./src/lib/issue-store.ts", \`file://\${repoRoot}/\`).href
      );
      const issueStore = issueStoreImported.default || issueStoreImported;

      const created = (await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "I", description: "" }),
          })
        )
      )).body;
      await issueStore.linkTask(created.id, "task-x");

      const blocked = await json(
        await issueDetailRoute.DELETE(
          request("http://localhost/api/issues/" + created.id, { method: "DELETE" }),
          { params: Promise.resolve({ id: created.id }) }
        )
      );
      assert.equal(blocked.status, 409);
    `)
  );
});

test("issues routes return validation and not-found errors", () => {
  runRouteAssertions(
    withCortexState(`
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );
      const commentsRoute = await loadRoute(
        "./src/app/api/issues/[id]/comments/route.ts"
      );

      const noTitle = await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ description: "x" }),
          })
        )
      );
      assert.equal(noTitle.status, 400);

      const missingGet = await json(
        await issueDetailRoute.GET(
          request("http://localhost/api/issues/missing"),
          { params: Promise.resolve({ id: "missing" }) }
        )
      );
      assert.equal(missingGet.status, 404);

      const missingDelete = await json(
        await issueDetailRoute.DELETE(
          request("http://localhost/api/issues/missing", { method: "DELETE" }),
          { params: Promise.resolve({ id: "missing" }) }
        )
      );
      assert.equal(missingDelete.status, 404);

      const created = (await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Live", description: "" }),
          })
        )
      )).body;

      const badStatus = await json(
        await issueDetailRoute.PUT(
          request("http://localhost/api/issues/" + created.id, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "bogus" }),
          }),
          { params: Promise.resolve({ id: created.id }) }
        )
      );
      assert.equal(badStatus.status, 400);

      const missingPut = await json(
        await issueDetailRoute.PUT(
          request("http://localhost/api/issues/missing", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "X" }),
          }),
          { params: Promise.resolve({ id: "missing" }) }
        )
      );
      assert.equal(missingPut.status, 404);

      const emptyComment = await json(
        await commentsRoute.POST(
          request("http://localhost/api/issues/" + created.id + "/comments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ id: created.id }) }
        )
      );
      assert.equal(emptyComment.status, 400);

      const missingComment = await json(
        await commentsRoute.POST(
          request("http://localhost/api/issues/missing/comments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "hi" }),
          }),
          { params: Promise.resolve({ id: "missing" }) }
        )
      );
      assert.equal(missingComment.status, 404);

      const okDelete = await json(
        await issueDetailRoute.DELETE(
          request("http://localhost/api/issues/" + created.id, { method: "DELETE" }),
          { params: Promise.resolve({ id: created.id }) }
        )
      );
      assert.equal(okDelete.status, 200);
      assert.equal(okDelete.body.ok, true);
    `)
  );
});

test("issues route accepts priority on create and sorts priority desc then updated_at", () => {
  runRouteAssertions(
    withCortexState(`
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );

      const create = (title, priority) =>
        issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, description: "", priority }),
          })
        );

      const none = (await json(await create("none"))).body;
      const low = (await json(await create("low", "low"))).body;
      const med = (await json(await create("med", "medium"))).body;
      const high = (await json(await create("high", "high"))).body;
      assert.equal(none.priority, undefined);
      assert.equal(low.priority, "low");
      assert.equal(med.priority, "medium");
      assert.equal(high.priority, "high");

      const list = (await json(
        await issuesRoute.GET(request("http://localhost/api/issues"))
      )).body;
      assert.deepEqual(
        list.items.map((i) => i.title),
        ["high", "med", "low", "none"]
      );

      const bad = await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "x", priority: "urgent" }),
          })
        )
      );
      assert.equal(bad.status, 400);

      const updated = (await json(
        await issueDetailRoute.PUT(
          request("http://localhost/api/issues/" + low.id, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ priority: "high" }),
          }),
          { params: Promise.resolve({ id: low.id }) }
        )
      )).body;
      assert.equal(updated.priority, "high");

      const cleared = (await json(
        await issueDetailRoute.PUT(
          request("http://localhost/api/issues/" + low.id, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ priority: null }),
          }),
          { params: Promise.resolve({ id: low.id }) }
        )
      )).body;
      assert.equal(cleared.priority, undefined);

      const badPut = await json(
        await issueDetailRoute.PUT(
          request("http://localhost/api/issues/" + low.id, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ priority: "urgent" }),
          }),
          { params: Promise.resolve({ id: low.id }) }
        )
      );
      assert.equal(badPut.status, 400);
    `)
  );
});

test("tasks route rejects unknown issue_id and tasks DELETE unlinks issue", () => {
  runRouteAssertions(
    withCortexState(`
      const tasksRoute = await loadRoute("./src/app/api/tasks/route.ts");
      const taskDetailRoute = await loadRoute(
        "./src/app/api/tasks/[id]/route.ts"
      );
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );

      const missingIssue = await json(
        await tasksRoute.POST(
          request("http://localhost/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "T",
              description: "",
              agent: "cortex-city-swe",
              issue_id: "missing",
            }),
          })
        )
      );
      assert.equal(missingIssue.status, 400);

      const issue = (await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "I", description: "" }),
          })
        )
      )).body;

      const task = (await json(
        await tasksRoute.POST(
          request("http://localhost/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "T",
              description: "",
              agent: "cortex-city-swe",
              issue_id: issue.id,
            }),
          })
        )
      )).body;

      const deleted = await json(
        await taskDetailRoute.DELETE(
          request("http://localhost/api/tasks/" + task.id, { method: "DELETE" }),
          { params: Promise.resolve({ id: task.id }) }
        )
      );
      assert.equal(deleted.status, 200);

      const reopened = (await json(
        await issueDetailRoute.GET(
          request("http://localhost/api/issues/" + issue.id),
          { params: Promise.resolve({ id: issue.id }) }
        )
      )).body;
      assert.equal(reopened.status, "open");
      assert.equal(reopened.task_id, undefined);
    `)
  );
});

test("tasks route links and syncs issue on POST and PUT", () => {
  runRouteAssertions(
    withCortexState(`
      const tasksRoute = await loadRoute("./src/app/api/tasks/route.ts");
      const taskDetailRoute = await loadRoute(
        "./src/app/api/tasks/[id]/route.ts"
      );
      const issuesRoute = await loadRoute("./src/app/api/issues/route.ts");
      const issueDetailRoute = await loadRoute(
        "./src/app/api/issues/[id]/route.ts"
      );

      const issue = (await json(
        await issuesRoute.POST(
          request("http://localhost/api/issues", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Source", description: "" }),
          })
        )
      )).body;

      const task = (await json(
        await tasksRoute.POST(
          request("http://localhost/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "From issue",
              description: "",
              agent: "cortex-city-swe",
              issue_id: issue.id,
            }),
          })
        )
      )).body;
      assert.equal(task.issue_id, issue.id);

      const linkedTask = (await json(
        await taskDetailRoute.GET(
          request("http://localhost/api/tasks/" + task.id),
          { params: Promise.resolve({ id: task.id }) }
        )
      )).body;
      assert.deepEqual(linkedTask.linked_issue, {
        id: issue.id,
        title: "Source",
        status: "in_progress",
      });

      const linkedIssue = (await json(
        await issueDetailRoute.GET(
          request("http://localhost/api/issues/" + issue.id),
          { params: Promise.resolve({ id: issue.id }) }
        )
      )).body;
      assert.equal(linkedIssue.task_id, task.id);
      assert.equal(linkedIssue.status, "in_progress");

      await taskDetailRoute.PUT(
        request("http://localhost/api/tasks/" + task.id, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "merged" }),
        }),
        { params: Promise.resolve({ id: task.id }) }
      );

      const doneIssue = (await json(
        await issueDetailRoute.GET(
          request("http://localhost/api/issues/" + issue.id),
          { params: Promise.resolve({ id: issue.id }) }
        )
      )).body;
      assert.equal(doneIssue.status, "done");

      const duplicate = await json(
        await tasksRoute.POST(
          request("http://localhost/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "Dupe",
              description: "",
              agent: "cortex-city-swe",
              issue_id: issue.id,
            }),
          })
        )
      );
      assert.equal(duplicate.status, 409);
    `)
  );
});
