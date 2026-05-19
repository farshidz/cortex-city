import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  DEFAULT_REVIEW_PROMPT,
  resolveReviewOpts,
  resolveReviewPrompt,
} from "./review-runner";
import {
  createTempWorkspace,
  moduleUrl,
  prependBinToPath,
  runTsxScript,
  writeFakeAgentBinary,
  writeJson,
  writeTestConfig,
} from "./test-harness";
import type { OrchestratorConfig, ReviewRequest } from "./types";

const REVIEW_RUNNER_MODULE_URL = moduleUrl("src/lib/review-runner.ts");
const REVIEW_STORE_MODULE_URL = moduleUrl("src/lib/review-store.ts");

function baseConfig(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return {
    max_parallel_sessions: 2,
    poll_interval_seconds: 30,
    default_permission_mode: "bypassPermissions",
    default_agent_runner: "claude",
    default_claude_model: "claude-sonnet-4-6",
    default_claude_effort: "high",
    default_codex_model: "gpt-5.4",
    default_codex_effort: "medium",
    agents: {},
    ...overrides,
  };
}

function sampleRequest(
  overrides: Partial<ReviewRequest> = {}
): ReviewRequest {
  return {
    pr_url: "https://github.com/acme/widget/pull/1",
    pr_number: 1,
    repo_slug: "acme/widget",
    title: "Add fizzbuzz",
    author: "octocat",
    head_sha: "abc123",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function setupRunnerWorkspace(
  prefix: string,
  configOverrides: Partial<OrchestratorConfig> = {}
): string {
  const workspace = createTempWorkspace(prefix);
  writeTestConfig(workspace, configOverrides, {
    "cortex-city-swe": {
      default_branch: "main",
    },
  });
  writeFakeAgentBinary(workspace, "claude");
  writeFakeAgentBinary(workspace, "codex");
  return workspace;
}

test("resolveReviewOpts prefers explicit overrides, then review_* config, then runtime defaults", () => {
  const config = baseConfig({
    review_runtime: "codex",
    review_effort: "high",
    review_model: "review-model",
  });
  const opts = resolveReviewOpts(config);
  assert.deepEqual(opts, {
    runtime: "codex",
    effort: "high",
    model: "review-model",
  });

  const overridden = resolveReviewOpts(config, {
    runtime: "claude",
    effort: "low",
    model: "  override  ",
  });
  assert.deepEqual(overridden, {
    runtime: "claude",
    effort: "low",
    model: "override",
  });
});

test("resolveReviewOpts falls back to runtime-specific defaults when review_* is unset", () => {
  const config = baseConfig({
    review_runtime: undefined,
    review_effort: undefined,
    review_model: undefined,
  });
  const claudeOpts = resolveReviewOpts(config);
  assert.deepEqual(claudeOpts, {
    runtime: "claude",
    effort: "high",
    model: "claude-sonnet-4-6",
  });

  const codexOpts = resolveReviewOpts(config, { runtime: "codex" });
  assert.deepEqual(codexOpts, {
    runtime: "codex",
    effort: "medium",
    model: "gpt-5.4",
  });
});

test("resolveReviewPrompt prefers the configured prompt and falls back to the default", () => {
  assert.equal(resolveReviewPrompt(baseConfig()), DEFAULT_REVIEW_PROMPT);
  const custom = baseConfig({ review_prompt: "  my prompt  " });
  assert.equal(resolveReviewPrompt(custom), "my prompt");
  const blank = baseConfig({ review_prompt: "   " });
  assert.equal(resolveReviewPrompt(blank), DEFAULT_REVIEW_PROMPT);
});

test("summarizePR persists Claude output as a ReviewSummary", () => {
  const workspace = setupRunnerWorkspace("review-runner-claude-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-1",
        result: "## Summary\nLooks fine.",
        is_error: false,
        duration_ms: 1234,
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    },
  });

  const request = sampleRequest();
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.summary.summary, "## Summary\nLooks fine.");
  assert.equal(result.summary.session_id, "claude-session-1");
  assert.equal(result.summary.runtime, "claude");
  assert.equal(result.summary.input_tokens, 12);
  assert.equal(result.summary.output_tokens, 34);
  assert.equal(result.summary.error, undefined);
  assert.equal(result.summary.current_run_pid, undefined);
  assert.equal(result.persisted.summary, "## Summary\nLooks fine.");
  assert.equal(result.persisted.session_id, "claude-session-1");
});

test("summarizePR persists Codex output as a ReviewSummary", () => {
  const workspace = setupRunnerWorkspace("review-runner-codex-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const codexStdout = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "## Summary\nCodex pass." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
    "",
  ].join("\n");
  writeJson(scenarioFile, { codex: { stdout: codexStdout } });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/2",
    pr_number: 2,
    head_sha: "def456",
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "codex" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.summary.summary, "## Summary\nCodex pass.");
  assert.equal(result.summary.session_id, "codex-thread-1");
  assert.equal(result.summary.runtime, "codex");
  assert.equal(result.summary.input_tokens, 5);
  assert.equal(result.summary.output_tokens, 7);
  assert.equal(result.persisted.session_id, "codex-thread-1");
});

test("summarizePR records error and preserves previous summary on non-zero exit", () => {
  const workspace = setupRunnerWorkspace("review-runner-error-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: { stderr: "boom", exitCode: 7 },
  });

  const request = sampleRequest();
  // Seed an existing summary to confirm it isn't wiped by a failed retry.
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "old text",
          generated_at: "2026-05-01T00:00:00.000Z",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "claude" });
      console.log(JSON.stringify({
        summary,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.ok(result.summary.error, "error should be populated");
  assert.match(result.summary.error, /boom|claude exited with code 7/);
  assert.equal(result.summary.summary, "old text");
  assert.equal(result.persisted.summary, "old text");
});

test("askFollowup throws when the cached entry has no summary yet", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-empty-");
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  const request = sampleRequest();
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "",
          generated_at: "",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let error = null;
      try {
        await askFollowup(${JSON.stringify(request.pr_url)}, "ping");
      } catch (err) {
        error = err.message;
      }
      console.log(JSON.stringify({ error }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.error, "Summary is not yet available for this PR.");
});

test("askFollowup throws when the PR has no cached summary", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-missing-");

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let error = null;
      try {
        await askFollowup("https://github.com/acme/widget/pull/999", "ping");
      } catch (err) {
        error = err.message;
      }
      console.log(JSON.stringify({ error }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(
    result.error,
    "No summary to follow up on; generate one first."
  );
});

test("askFollowup resumes the cached session on the happy path", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-resume-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-1",
        result: "Answered via resume.",
        is_error: false,
        duration_ms: 200,
      }),
    },
  });

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "previous summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
          session_id: "claude-session-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what does it do?");
      console.log(JSON.stringify(followup));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.resumed, true);
  assert.equal(result.answer, "Answered via resume.");
  assert.equal(result.session_id, "claude-session-1");
  assert.equal(result.error, undefined);
});

test("askFollowup falls back to a fresh session when resume fails", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-fallback-");
  // Replace the fake claude with one that fails when --resume is passed and
  // succeeds otherwise, so we exercise both code paths from a single test.
  const claudePath = path.join(workspace, "bin", "claude");
  writeFileSync(
    claudePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--resume")) {
  process.stderr.write("session not found");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(
      JSON.stringify({
        session_id: "claude-session-2",
        result: "Answered freshly.",
        is_error: false,
        duration_ms: 200,
      })
    )});
`
  );
  chmodSync(claudePath, 0o755);

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "previous summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "claude",
          session_id: "claude-session-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what does it do?");
      console.log(JSON.stringify(followup));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.resumed, false);
  assert.equal(result.answer, "Answered freshly.");
  assert.equal(result.session_id, "claude-session-2");
});

test("appendFollowup adds entries to the cached transcript", () => {
  const workspace = setupRunnerWorkspace("review-runner-append-");
  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          followups: [],
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { appendFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      const followup = {
        asked_at: "2026-05-02T00:00:00.000Z",
        question: "what?",
        answered_at: "2026-05-02T00:00:01.000Z",
        answer: "this",
        resumed: true,
      };
      const updated = await appendFollowup(${JSON.stringify(request.pr_url)}, followup);
      console.log(JSON.stringify({
        updated,
        persisted: readReviewSummaryMap()[${JSON.stringify(request.pr_url)}],
      }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.updated.followups.length, 1);
  assert.equal(result.updated.followups[0].question, "what?");
  assert.equal(result.persisted.followups.length, 1);
});

test("appendFollowup returns undefined for unknown pr_urls", () => {
  const workspace = setupRunnerWorkspace("review-runner-append-missing-");
  const result = runTsxScript(
    workspace,
    [
      `import { appendFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const updated = await appendFollowup(
        "https://github.com/missing/repo/pull/9",
        {
          asked_at: "2026-05-02T00:00:00.000Z",
          question: "?",
          answered_at: "2026-05-02T00:00:01.000Z",
          answer: "",
          resumed: false,
        }
      );
      console.log(JSON.stringify({ updated: updated ?? null }));
    `,
    prependBinToPath(workspace)
  );

  assert.equal(result.updated, null);
});

test("askFollowup over codex uses the resume flow when a session id is cached", () => {
  const workspace = setupRunnerWorkspace("review-runner-followup-codex-");
  const scenarioFile = path.join(workspace, "scenario.json");
  const codexStdout = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Codex follow-up answer." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
    "",
  ].join("\n");
  writeJson(scenarioFile, { codex: { stdout: codexStdout } });

  const request = sampleRequest();
  const reviewsFile = path.join(workspace, ".cortex", "reviews.json");
  mkdirSync(path.dirname(reviewsFile), { recursive: true });
  writeFileSync(
    reviewsFile,
    JSON.stringify(
      {
        [request.pr_url]: {
          ...request,
          summary: "prior summary",
          generated_at: "2026-05-01T00:00:00.000Z",
          runtime: "codex",
          session_id: "codex-thread-1",
        },
      },
      null,
      2
    )
  );

  const result = runTsxScript(
    workspace,
    [
      `import { askFollowup } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const followup = await askFollowup(${JSON.stringify(request.pr_url)}, "what next?");
      console.log(JSON.stringify(followup));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.resumed, true);
  assert.equal(result.answer, "Codex follow-up answer.");
  assert.equal(result.session_id, "codex-thread-1");
});

test("summarizePR over codex records an error on non-zero exit", () => {
  const workspace = setupRunnerWorkspace("review-runner-codex-error-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    codex: { stderr: "codex blew up", exitCode: 5 },
  });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/77",
    pr_number: 77,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      const summary = await summarizePR(${JSON.stringify(request)}, { runtime: "codex" });
      console.log(JSON.stringify(summary));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );
  assert.ok(result.error, "error should be populated");
  assert.match(result.error, /codex blew up|codex exited with code 5/);
});

test("spawnReviewSummary invokes the onComplete hook with the final summary", () => {
  const workspace = setupRunnerWorkspace("review-runner-onComplete-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "claude-session-x",
        result: "Looks good.",
        is_error: false,
        duration_ms: 5,
      }),
    },
  });

  const request = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/100",
    pr_number: 100,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { spawnReviewSummary } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
    ],
    `
      let onCompleteSeen = null;
      const spawned = await spawnReviewSummary(
        ${JSON.stringify(request)},
        { runtime: "claude" },
        (summary) => { onCompleteSeen = summary; }
      );
      const final = await spawned.done;
      console.log(JSON.stringify({
        pid: typeof spawned.pid,
        final: { summary: final.summary, runtime: final.runtime },
        onCompleteSeenSummary: onCompleteSeen ? onCompleteSeen.summary : null,
      }));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );

  assert.equal(result.pid, "number");
  assert.equal(result.final.summary, "Looks good.");
  assert.equal(result.final.runtime, "claude");
  assert.equal(result.onCompleteSeenSummary, "Looks good.");
});

test("disk write race does not corrupt reviews.json under concurrent summarizations", () => {
  // Smoke test that the store mutex serialises writes from two summary runs.
  const workspace = setupRunnerWorkspace("review-runner-concurrent-");
  const scenarioFile = path.join(workspace, "scenario.json");
  writeJson(scenarioFile, {
    claude: {
      stdout: JSON.stringify({
        session_id: "s",
        result: "ok",
        is_error: false,
        duration_ms: 1,
      }),
    },
  });

  const requestA = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/10",
    pr_number: 10,
  });
  const requestB = sampleRequest({
    pr_url: "https://github.com/acme/widget/pull/11",
    pr_number: 11,
  });
  const result = runTsxScript(
    workspace,
    [
      `import { summarizePR } from ${JSON.stringify(REVIEW_RUNNER_MODULE_URL)};`,
      `import { readReviewSummaryMap } from ${JSON.stringify(REVIEW_STORE_MODULE_URL)};`,
    ],
    `
      await Promise.all([
        summarizePR(${JSON.stringify(requestA)}, { runtime: "claude" }),
        summarizePR(${JSON.stringify(requestB)}, { runtime: "claude" }),
      ]);
      console.log(JSON.stringify(Object.keys(readReviewSummaryMap()).sort()));
    `,
    {
      ...prependBinToPath(workspace),
      FAKE_AGENT_SCENARIO_FILE: scenarioFile,
    }
  );
  assert.deepEqual(result, [requestA.pr_url, requestB.pr_url]);
  // Final file is parseable JSON with both entries.
  const persisted = JSON.parse(
    readFileSync(path.join(workspace, ".cortex", "reviews.json"), "utf-8")
  );
  assert.deepEqual(
    Object.keys(persisted).sort(),
    [requestA.pr_url, requestB.pr_url].sort()
  );
});
