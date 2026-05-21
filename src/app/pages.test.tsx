import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  REVIEW_STATUS_BADGE_CLASSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_ROW_CLASSES,
} from "../lib/review-status-presentation";

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
        const handlers = [];

        function captureHandlers(props) {
          if (!props || typeof props !== "object") return;
          for (const name of [
            "onClick",
            "onChange",
            "onOpenChange",
            "onSubmit",
            "onValueChange",
          ]) {
            if (typeof props[name] === "function") {
              handlers.push({ name, fn: props[name] });
            }
          }
        }

        async function invokeHandlers() {
          let count = 0;
          const event = {
            preventDefault() {},
            stopPropagation() {},
            target: { value: "updated", checked: true },
            currentTarget: { value: "updated", checked: true },
          };
          const values = ["codex", "claude", "__default__", "open", "closed"];
          while (handlers.length > 0 && count < 500) {
            const { name, fn } = handlers.shift();
            try {
              if (name === "onValueChange") {
                for (const value of values) await fn(value);
              } else if (name === "onOpenChange") {
                await fn(false);
                await fn(true);
              } else if (name === "onChange" || name === "onSubmit") {
                await fn(event);
              } else {
                await fn(event);
              }
              count += 1;
            } catch {}
          }
          return count;
        }

        Module._load = function(request, parent, isMain) {
          if (request === "react/jsx-runtime" || request === "react/jsx-dev-runtime") {
            const runtime = originalLoad.apply(this, arguments);
            const wrap = (name) =>
              typeof runtime[name] === "function"
                ? (...args) => {
                    captureHandlers(args[1]);
                    return runtime[name](...args);
                  }
                : runtime[name];
            return {
              ...runtime,
              jsx: wrap("jsx"),
              jsxs: wrap("jsxs"),
              jsxDEV: wrap("jsxDEV"),
            };
          }
          if (request === "react") {
            const react = originalLoad.apply(this, arguments);
            return {
              ...react,
              useState(initial) {
                const queue = globalThis.__STATE_OVERRIDES__;
                const next =
                  Array.isArray(queue) && queue.length > 0
                    ? queue.shift()
                    : initial;
                return react.useState(next);
              },
            };
          }
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
              mutate() {
                globalThis.__MUTATE_COUNT__ =
                  (globalThis.__MUTATE_COUNT__ || 0) + 1;
                return Promise.resolve();
              },
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
          globalThis.__ROUTER_PUSHES__ = [];
          globalThis.__MUTATE_COUNT__ = 0;
          const router = {
            back() {},
            forward() {},
            prefetch() { return Promise.resolve(); },
            push(path) { globalThis.__ROUTER_PUSHES__.push(path); },
            replace() {},
            refresh() {},
            hmrRefresh() {},
          };
          globalThis.confirm = () => true;
          globalThis.prompt = () => "confirm";
          globalThis.requestAnimationFrame = (cb) => {
            cb();
            return 1;
          };
          globalThis.cancelAnimationFrame = () => {};
          globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
            text: async () => "",
          });

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

          async function renderPage(relativePath, props = {}, stateOverrides = []) {
            const Component = await loadComponent(relativePath);
            globalThis.__STATE_OVERRIDES__ = [...stateOverrides];
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
            notes: "Existing notes",
            pending_manual_instruction: "wait for input",
            last_agent_report: {
              status: "completed",
              summary: "Finished the work",
              files_changed: ["src/app/page.tsx"],
              assumptions: ["Assumed defaults"],
              blockers: ["None"],
              next_steps: ["Merge"],
            },
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
            review_status: "new_commits",
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
          const unchangedReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/2",
            pr_number: 2,
            title: "Unchanged review",
            head_sha: "same-sha",
            my_last_review_sha: "same-sha",
            review_status: "up_to_date",
          };
          const runningReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/3",
            pr_number: 3,
            title: "Running review",
            summary: "",
            current_run_pid: 789,
            review_status: "summarizing",
          };
          const errorReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/4",
            pr_number: 4,
            title: "Errored review",
            summary: "",
            error: "Unable to summarize",
            review_status: "summary_error",
            followups: [
              {
                asked_at: now,
                question: "Did it fail?",
                answered_at: now,
                answer: "",
                error: "Follow-up failed",
                resumed: true,
              },
            ],
          };
          const emptyReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/5",
            pr_number: 5,
            title: "Empty review",
            summary: "",
            generated_at: "",
            review_status: "pending_summary",
            followups: [
              {
                asked_at: now,
                question: "Anything?",
                answered_at: now,
                answer: "",
                resumed: false,
              },
            ],
          };
          const needsReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/7",
            pr_number: 7,
            title: "Needs review",
            my_last_review_sha: undefined,
            review_status: "needs_review",
          };
          const finalReview = {
            ...review,
            pr_url: "https://github.com/acme/widget/pull/6",
            pr_number: 6,
            title: "Final review",
            final_at: now,
            review_status: "final",
          };
          const closedTask = {
            ...task,
            id: "task-2",
            title: "Merged task",
            status: "merged",
            pr_status: "clean",
            total_input_tokens: 1250000,
            total_output_tokens: 250000,
            total_duration_ms: 7200000,
            current_run_pid: undefined,
          };
          globalThis.__SWR_DATA__ = {
            "/api/tasks": [
              task,
              closedTask,
              { ...task, id: "task-3", title: "Failing checks", pr_status: "checks_failing" },
              { ...task, id: "task-4", title: "Conflicts", pr_status: "conflicts" },
              { ...task, id: "task-5", title: "Needs approval", pr_status: "needs_approval" },
              { ...task, id: "task-6", title: "Running", current_run_pid: 456 },
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
            "/api/reviews": [
              needsReview,
              review,
              unchangedReview,
              runningReview,
              errorReview,
              emptyReview,
              finalReview,
            ],
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
      const handlerCount = await invokeHandlers();
      console.log(JSON.stringify({ relativePath, handlerCount, length: html.length }));
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

test("app pages render editable and alternate states", () => {
  const output = runRenderScript(`
    const newAgent = {
      key: "new-agent",
      name: "New Agent",
      repo_slug: "acme/widget",
      description: "Handles widget work",
      prompt_file: "prompts/agents/new-agent.md",
      review_prompt_file: "prompts/agents/new-agent.review.md",
      cleanup_prompt_file: "prompts/agents/new-agent.cleanup.md",
      default_branch: "main",
      git_user_name: "Agent User",
      git_user_email: "agent@example.com",
    };
    const agentDetailOverrides = [
      {
        initial: "Initial prompt",
        review: "Review prompt",
        cleanup: "Cleanup prompt",
      },
      { initial: true, review: true, cleanup: true },
      null,
      false,
      true,
      { ...config.agents["cortex-city-swe"], name: "Edited Agent" },
      "cleanup",
      [{ key: "TOKEN", value: "secret" }],
      true,
    ];
    const taskEditOverrides = [
      true,
      {
        title: "Edited task",
        agent: "cortex-city-swe",
        agent_runner: "codex",
        permission_mode: "acceptEdits",
        model: "gpt-5.4",
        effort: "medium",
        description: "Edited description",
        plan: "Edited plan",
      },
      "Edited notes",
      false,
      true,
      "continue carefully",
      false,
      "Instruction failed",
    ];
    const variants = [
      [
        "./src/app/agents/page.tsx",
        {},
        [
          true,
          newAgent,
          {
            initial: "Initial custom prompt",
            review: "Review custom prompt",
            cleanup: "Cleanup custom prompt",
          },
          "review",
          [{ key: "TOKEN", value: "secret" }],
          true,
        ],
      ],
      [
        "./src/app/agents/[id]/page.tsx",
        { params: Promise.resolve({ id: "cortex-city-swe" }) },
        agentDetailOverrides,
      ],
      ["./src/app/settings/page.tsx", {}, [false, config]],
      [
        "./src/app/tasks/[id]/page.tsx",
        { params: Promise.resolve({ id: "task-1" }) },
        taskEditOverrides,
      ],
      [
        "./src/app/tasks/new/page.tsx",
        {},
        [
          config,
          "New task",
          "Description",
          "Plan",
          "cortex-city-swe",
          "agent/new-task",
          "codex",
          "acceptEdits",
          "gpt-5.4",
          "medium",
          false,
        ],
      ],
    ];

    for (const [relativePath, props, stateOverrides] of variants) {
      const html = await renderPage(relativePath, props, stateOverrides);
      const handlerCount = await invokeHandlers();
      console.log(JSON.stringify({ relativePath, handlerCount, length: html.length }));
    }

    const reviewMissing = await renderPage(
      "./src/app/reviews/[id]/page.tsx",
      {
        params: Promise.resolve({
          id: Buffer.from("https://github.com/acme/widget/pull/404", "utf-8")
            .toString("base64url"),
        }),
      }
    );
    console.log(JSON.stringify({ relativePath: "missing-review", length: reviewMissing.length }));

    const invalidReview = await renderPage(
      "./src/app/reviews/[id]/page.tsx",
      { params: Promise.resolve({ id: "not-valid" }) }
    );
    console.log(JSON.stringify({ relativePath: "invalid-review", length: invalidReview.length }));
  `);

  const rows = output.map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((row) => row.relativePath),
    [
      "./src/app/agents/page.tsx",
      "./src/app/agents/[id]/page.tsx",
      "./src/app/settings/page.tsx",
      "./src/app/tasks/[id]/page.tsx",
      "./src/app/tasks/new/page.tsx",
      "missing-review",
      "invalid-review",
    ]
  );
  assert.ok(
    rows.slice(0, 5).reduce((sum, row) => sum + row.handlerCount, 0) > 20
  );
  for (const row of rows) {
    assert.ok(row.length > 0);
  }
});

test("app pages render loading, empty, and detail variants", () => {
  const output = runRenderScript(`
    const originalData = globalThis.__SWR_DATA__;
    const configVariant = {
      ...config,
      default_agent_runner: "claude",
      default_permission_mode: "bypassPermissions",
      default_codex_effort: undefined,
      default_claude_effort: undefined,
      review_runtime: "claude",
      review_effort: undefined,
      max_parallel_reviews: undefined,
    };
    const variantTask = {
      ...task,
      id: "task-variant",
      status: "open",
      agent_runner: "claude",
      permission_mode: "bypassPermissions",
      session_id: undefined,
      pr_url: undefined,
      pr_status: undefined,
      current_run_pid: undefined,
      pending_manual_instruction: undefined,
      child_tasks: [],
      last_agent_report: undefined,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      total_duration_ms: 0,
      last_run_at: undefined,
    };
    const loadingPages = [
      ["./src/app/agents/page.tsx", {}],
      ["./src/app/agents/[id]/page.tsx", { params: Promise.resolve({ id: "missing" }) }],
      ["./src/app/settings/page.tsx", {}],
      ["./src/app/tasks/[id]/page.tsx", { params: Promise.resolve({ id: "task-1" }) }],
      ["./src/app/tasks/new/page.tsx", {}],
    ];

    globalThis.__SWR_DATA__ = {};
    for (const [relativePath, props] of loadingPages) {
      const html = await renderPage(relativePath, props);
      console.log(JSON.stringify({ relativePath: relativePath + "#loading", length: html.length }));
    }

    globalThis.__SWR_DATA__ = {
      ...originalData,
      "/api/tasks": [],
      "/api/reviews": [],
      "/api/sessions": [],
      "/api/orchestrator": {
        running: false,
        healthy: false,
        worker_healthy: false,
        autostart_enabled: false,
        active_sessions: 0,
        max_sessions: 3,
        last_poll_at: undefined,
        last_heartbeat_at: undefined,
        poll_in_progress: false,
      },
    };
    for (const relativePath of [
      "./src/app/page.tsx",
      "./src/app/reviews/page.tsx",
      "./src/app/sessions/page.tsx",
    ]) {
      const html = await renderPage(relativePath);
      const handlerCount = await invokeHandlers();
      console.log(JSON.stringify({ relativePath: relativePath + "#empty", handlerCount, length: html.length }));
    }

    globalThis.__SWR_DATA__ = {
      ...originalData,
      "/api/config": configVariant,
      "/api/tasks/task-variant": variantTask,
    };
    const variantPages = [
      ["./src/app/settings/page.tsx", {}, [true, configVariant]],
      [
        "./src/app/tasks/[id]/page.tsx",
        { params: Promise.resolve({ id: "task-variant" }) },
        [false, {}, undefined, false, false, "", false, null],
      ],
      [
        "./src/app/tasks/new/page.tsx",
        {},
        [
          configVariant,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          true,
        ],
      ],
    ];
    for (const [relativePath, props, stateOverrides] of variantPages) {
      const html = await renderPage(relativePath, props, stateOverrides);
      const handlerCount = await invokeHandlers();
      console.log(JSON.stringify({ relativePath: relativePath + "#variant", handlerCount, length: html.length }));
    }

    globalThis.__SWR_DATA__ = originalData;
    for (const prUrl of [
      "https://github.com/acme/widget/pull/2",
      "https://github.com/acme/widget/pull/3",
      "https://github.com/acme/widget/pull/4",
      "https://github.com/acme/widget/pull/5",
    ]) {
      const html = await renderPage(
        "./src/app/reviews/[id]/page.tsx",
        {
          params: Promise.resolve({
            id: Buffer.from(prUrl, "utf-8").toString("base64url"),
          }),
        }
      );
      const handlerCount = await invokeHandlers();
      console.log(JSON.stringify({ relativePath: prUrl, handlerCount, length: html.length }));
    }
  `);

  const rows = output.map((line) => JSON.parse(line));
  assert.equal(rows.length, 15);
  for (const row of rows) {
    assert.ok(row.length > 0);
  }
});

test("review status presentation matches expected labels and classes", () => {
  assert.deepEqual(REVIEW_STATUS_LABELS, {
    needs_review: "Awaiting your review",
    new_commits: "New commits since your review",
    up_to_date: "Up to date with your review",
    pending_summary: "No summary yet",
    summarizing: "Summary being generated",
    summary_error: "Summary error",
    final: "No longer live",
  });
  assert.deepEqual(REVIEW_STATUS_ROW_CLASSES, {
    needs_review: "bg-yellow-500/10",
    new_commits: "bg-yellow-500/10",
    up_to_date: "bg-green-500/10",
    pending_summary: "",
    summarizing: "animate-pulse-green",
    summary_error: "bg-red-500/10",
    final: "bg-muted/40 opacity-60",
  });
  assert.deepEqual(REVIEW_STATUS_BADGE_CLASSES, {
    needs_review: "bg-yellow-100 text-yellow-800",
    new_commits: "bg-yellow-100 text-yellow-800",
    up_to_date: "bg-green-100 text-green-800",
    pending_summary: "bg-blue-100 text-blue-800",
    summarizing: "bg-green-100 text-green-800",
    summary_error: "bg-red-100 text-red-800",
    final: "bg-gray-100 text-gray-800",
  });
});

test("reviews page renders final reviews and backend status labels", () => {
  const output = runRenderScript(`
    const html = await renderPage("./src/app/reviews/page.tsx");
    console.log(JSON.stringify({
      needsReview: html.includes("Awaiting your review"),
      newCommits: html.includes("New commits since your review"),
      upToDate: html.includes("Up to date with your review"),
      pendingSummary: html.includes("No summary yet"),
      summarizing: html.includes("Summary being generated"),
      summaryError: html.includes("Summary error"),
      finalLabel: html.includes("No longer live"),
      finalRow: html.includes("Final review"),
    }));
  `);

  assert.deepEqual(JSON.parse(output[0]), {
    needsReview: true,
    newCommits: true,
    upToDate: true,
    pendingSummary: true,
    summarizing: true,
    summaryError: true,
    finalLabel: true,
    finalRow: true,
  });
});

test("review detail submit success navigates back to reviews", () => {
  const output = runRenderScript(`
    globalThis.fetch = async (url, init = {}) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        url,
        method: init.method,
      }),
      text: async () => "",
    });
    await renderPage(
      "./src/app/reviews/[id]/page.tsx",
      {
        params: Promise.resolve({
          id: Buffer.from("https://github.com/acme/widget/pull/1", "utf-8")
            .toString("base64url"),
        }),
      },
      [
        "",
        false,
        false,
        "",
        "",
        { decision: "approve", body: "LGTM", submitting: false },
      ]
    );
    await invokeHandlers();
    console.log(JSON.stringify({
      pushes: globalThis.__ROUTER_PUSHES__,
      mutateCount: globalThis.__MUTATE_COUNT__,
    }));
  `);

  assert.deepEqual(JSON.parse(output[0]).pushes, ["/reviews"]);
  assert.ok(JSON.parse(output[0]).mutateCount > 0);
});

test("task detail collapses large plans by default and can expand them", () => {
  const output = runRenderScript(`
    const originalData = globalThis.__SWR_DATA__;
    const largePlan = Array.from(
      { length: 14 },
      (_, i) => "Step " + (i + 1) + ": do focused work"
    ).join("\\n");

    globalThis.__SWR_DATA__ = {
      ...originalData,
      "/api/tasks/task-large-plan": {
        ...task,
        id: "task-large-plan",
        plan: largePlan,
        pending_manual_instruction: undefined,
      },
    };

    const collapsedHtml = await renderPage(
      "./src/app/tasks/[id]/page.tsx",
      { params: Promise.resolve({ id: "task-large-plan" }) }
    );
    const expandedHtml = await renderPage(
      "./src/app/tasks/[id]/page.tsx",
      { params: Promise.resolve({ id: "task-large-plan" }) },
      [
        false,
        {},
        undefined,
        false,
        false,
        "",
        false,
        null,
        { taskId: "task-large-plan", plan: largePlan, expanded: true },
      ]
    );
    globalThis.__SWR_DATA__ = originalData;

    console.log(JSON.stringify({
      collapsedHasPlanBody: collapsedHtml.includes("Step 14: do focused work"),
      collapsedHasShow: collapsedHtml.includes("Show plan"),
      expandedHasPlanBody: expandedHtml.includes("Step 14: do focused work"),
      expandedHasHide: expandedHtml.includes("Hide plan"),
    }));
  `);

  assert.deepEqual(JSON.parse(output[0]), {
    collapsedHasPlanBody: false,
    collapsedHasShow: true,
    expandedHasPlanBody: true,
    expandedHasHide: true,
  });
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
