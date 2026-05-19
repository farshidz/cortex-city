import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = process.cwd();
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function runRenderScript(body: string): string[] {
  const output = execFileSync(
    TSX_BIN,
    [
      "--eval",
      `
        const Module = require("node:module");
        const originalLoad = Module._load;
        Module._load = function(request, parent, isMain) {
          if (request === "next/font/google") {
            const font = (opts = {}) => ({
              className: "font",
              variable: opts.variable || "font",
              style: {},
            });
            return { Inter: font, JetBrains_Mono: font };
          }
          if (request === "swr") {
            const useSWR = (key) => ({
              data: globalThis.__SWR_DATA__?.[
                typeof key === "string" ? key : JSON.stringify(key)
              ],
              mutate() {},
            });
            useSWR.default = useSWR;
            return useSWR;
          }
          return originalLoad.apply(this, arguments);
        };
        require.extensions[".css"] = () => {};

        (async () => {
          const React = await import("react");
          const { renderToPipeableStream } = await import("react-dom/server");
          const { PassThrough } = await import("node:stream");
          const { AppRouterContext } = await import(
            "next/dist/shared/lib/app-router-context.shared-runtime"
          );
          const router = {
            back() {},
            forward() {},
            prefetch() { return Promise.resolve(); },
            push() {},
            replace() {},
            refresh() {},
            hmrRefresh() {},
          };

          async function loadComponent(relativePath) {
            const imported = await import(new URL(relativePath, "file://${REPO_ROOT}/").href);
            return imported.default?.default || imported.default;
          }

          async function render(element) {
            let html = "";
            await new Promise((resolve, reject) => {
              const stream = renderToPipeableStream(element, {
                onAllReady() {
                  const body = new PassThrough();
                  body.on("data", (chunk) => {
                    html += chunk;
                  });
                  body.on("end", resolve);
                  stream.pipe(body);
                },
                onError(error) {
                  reject(error);
                },
              });
            });
            return html;
          }

          async function renderPage(relativePath, props = {}) {
            const Component = await loadComponent(relativePath);
            return render(
              React.createElement(
                AppRouterContext.Provider,
                { value: router },
                React.createElement(Component, props)
              )
            );
          }

          const now = "2026-05-19T07:00:00.000Z";
          const task = {
            id: "task-1",
            title: "Add app coverage",
            description: "Cover the app surface",
            plan: "Add focused tests",
            status: "in_review",
            agent: "cortex-city-swe",
            agent_runner: "codex",
            permission_mode: "acceptEdits",
            model: "gpt-5.4",
            effort: "medium",
            pr_url: "https://github.com/acme/widget/pull/1",
            pr_status: "checks_pending",
            created_at: now,
            updated_at: now,
            last_run_at: now,
            run_count: 2,
            total_input_tokens: 1200,
            total_output_tokens: 400,
            total_duration_ms: 900000,
            child_tasks: [
              {
                id: "child-1",
                title: "Follow-up",
                status: "open",
                agent: "cortex-city-swe",
              },
            ],
          };
          const config = {
            max_parallel_sessions: 2,
            poll_interval_seconds: 30,
            task_run_timeout_ms: 7200000,
            default_permission_mode: "acceptEdits",
            default_agent_runner: "codex",
            default_codex_model: "gpt-5.4",
            default_codex_effort: "medium",
            default_claude_model: "claude-sonnet-4-6",
            default_claude_effort: "high",
            review_runtime: "codex",
            review_effort: "medium",
            agents: {
              "cortex-city-swe": {
                name: "Cortex City SWE",
                repo_slug: "farshidz/cortex-city",
                prompt_file: "prompts/agents/cortex-city-swe.md",
                review_prompt_file: "prompts/agents/cortex-city-swe.review.md",
                cleanup_prompt_file: "prompts/agents/cortex-city-swe.cleanup.md",
                default_branch: "main",
                description: "Owns Cortex City",
              },
            },
          };
          const review = {
            pr_url: "https://github.com/acme/widget/pull/1",
            pr_number: 1,
            repo_slug: "acme/widget",
            title: "Add app coverage",
            author: "octocat",
            head_sha: "abc123",
            my_last_review_sha: "oldsha",
            created_at: now,
            updated_at: now,
            summary: "Looks focused.",
            generated_at: now,
            runtime: "codex",
            effort: "medium",
            followups: [
              {
                asked_at: now,
                question: "What changed?",
                answered_at: now,
                answer: "Coverage changed.",
                resumed: false,
              },
            ],
          };
          globalThis.__SWR_DATA__ = {
            "/api/tasks": [
              task,
              { ...task, id: "task-2", title: "Merged task", status: "merged" },
            ],
            "/api/tasks/task-1": task,
            "/api/tasks/task-1/session": {
              session_id: "session-1",
              message_count: 2,
              messages: [
                {
                  role: "user",
                  content: "Please continue",
                  timestamp: now,
                },
                {
                  role: "assistant",
                  content: "Done",
                  timestamp: now,
                  tool_calls: [{ name: "bash", input: "npm test" }],
                },
              ],
              agent_runner: "codex",
            },
            "/api/config": config,
            "/api/prompts": {
              initial: "Initial {{TASK_TITLE}}",
              review: "Review {{PR_URL}}",
              cleanup: "Cleanup {{TASK_TITLE}}",
            },
            "/api/agents/cortex-city-swe/prompt?mode=initial": {
              content: "Initial prompt",
              path: "prompts/agents/cortex-city-swe.md",
            },
            "/api/agents/cortex-city-swe/prompt?mode=review": {
              content: "Review prompt",
              path: "prompts/agents/cortex-city-swe.review.md",
            },
            "/api/agents/cortex-city-swe/prompt?mode=cleanup": {
              content: "Cleanup prompt",
              path: "prompts/agents/cortex-city-swe.cleanup.md",
            },
            "/api/agents/cortex-city-swe/env": {
              vars: { TOKEN: "secret" },
              path: "prompts/agents/.env.cortex-city-swe",
            },
            "/api/reviews": [review],
            "/api/sessions": [
              {
                kind: "task",
                task_id: "task-1",
                task_title: "Add app coverage",
                agent: "cortex-city-swe",
                session_id: "session-1",
                pid: 123,
                started_at: now,
                status: "running",
              },
              {
                kind: "review",
                task_id: review.pr_url,
                task_title: review.title,
                agent: "reviewer",
                session_id: "session-2",
                pid: 124,
                started_at: now,
                status: "running",
              },
            ],
            "/api/orchestrator": {
              running: true,
              healthy: true,
              worker_healthy: true,
              autostart_enabled: true,
              active_sessions: 2,
              max_sessions: 3,
              last_poll_at: now,
              last_heartbeat_at: now,
              started_at: now,
              poll_started_at: now,
              poll_finished_at: now,
              poll_in_progress: true,
            },
          };

          ${body}
        })().catch((error) => {
          console.error(error);
          process.exit(1);
        });
      `,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }
  );

  return output.trim().split(/\r?\n/).filter(Boolean);
}

test("app pages render their initial state", () => {
  const output = runRenderScript(`
    const pages = [
      ["./src/app/page.tsx", {}],
      ["./src/app/agents/page.tsx", {}],
      ["./src/app/agents/[id]/page.tsx", { params: Promise.resolve({ id: "cortex-city-swe" }) }],
      ["./src/app/reviews/page.tsx", {}],
      [
        "./src/app/reviews/[id]/page.tsx",
        {
          params: Promise.resolve({
            id: Buffer.from("https://github.com/acme/widget/pull/1", "utf-8")
              .toString("base64url"),
          }),
        },
      ],
      ["./src/app/sessions/page.tsx", {}],
      ["./src/app/settings/page.tsx", {}],
      ["./src/app/tasks/[id]/page.tsx", { params: Promise.resolve({ id: "task-1" }) }],
      ["./src/app/tasks/[id]/session/page.tsx", { params: Promise.resolve({ id: "task-1" }) }],
      ["./src/app/tasks/new/page.tsx", {}],
    ];

    for (const [relativePath, props] of pages) {
      const html = await renderPage(relativePath, props);
      console.log(JSON.stringify({ relativePath, length: html.length }));
    }
  `);

  assert.deepEqual(
    output.map((line) => JSON.parse(line).relativePath),
    [
      "./src/app/page.tsx",
      "./src/app/agents/page.tsx",
      "./src/app/agents/[id]/page.tsx",
      "./src/app/reviews/page.tsx",
      "./src/app/reviews/[id]/page.tsx",
      "./src/app/sessions/page.tsx",
      "./src/app/settings/page.tsx",
      "./src/app/tasks/[id]/page.tsx",
      "./src/app/tasks/[id]/session/page.tsx",
      "./src/app/tasks/new/page.tsx",
    ]
  );
  for (const line of output) {
    assert.ok(JSON.parse(line).length > 0);
  }
});

test("root layout renders navigation around page content", () => {
  const output = runRenderScript(`
    const Layout = await loadComponent("./src/app/layout.tsx");
    const html = await render(
      React.createElement(Layout, {
        children: React.createElement("div", null, "child content"),
      })
    );
    console.log(html);
  `);

  const html = output.join("\n");
  assert.match(html, /Cortex City/);
  assert.match(html, /child content/);
});
