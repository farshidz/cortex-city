import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime } from "./types";

export const REVIEW_WORKSPACE_PREFIX = "review-run-";
export const REVIEW_WORKSPACE_MARKER = ".cortex-city-review-workspace.json";

export interface ReviewWorkspace {
  path: string;
  markerPath: string;
  marker: ReviewWorkspaceMarker;
}

type ReviewWorkspaceEnv = Readonly<Record<string, string | undefined>>;

interface ReviewWorkspaceMarker {
  schema_version: 1;
  owner: "cortex-city";
  purpose: "review-runtime";
  runtime: AgentRuntime;
  launcher_pid: number;
  runtime_pid?: number;
  created_at: string;
  updated_at: string;
}

function writeMarker(markerPath: string, marker: ReviewWorkspaceMarker): void {
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function resolveReviewWorkspaceRoot(
  env: ReviewWorkspaceEnv = process.env,
  appRoot = process.cwd()
): string {
  const configured = env.CORTEX_REVIEW_WORKSPACE_ROOT?.trim();
  return configured
    ? path.resolve(appRoot, configured)
    : path.join(appRoot, "tmp", "reviews");
}

export function createReviewWorkspace(
  runtime: AgentRuntime,
  env: ReviewWorkspaceEnv = process.env,
  appRoot = process.cwd()
): ReviewWorkspace {
  const root = resolveReviewWorkspaceRoot(env, appRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspacePath = realpathSync(
    mkdtempSync(path.join(root, REVIEW_WORKSPACE_PREFIX))
  );
  const markerPath = path.join(workspacePath, REVIEW_WORKSPACE_MARKER);
  const now = new Date().toISOString();
  const marker: ReviewWorkspaceMarker = {
    schema_version: 1,
    owner: "cortex-city",
    purpose: "review-runtime",
    runtime,
    launcher_pid: process.pid,
    created_at: now,
    updated_at: now,
  };
  try {
    writeMarker(markerPath, marker);
  } catch (error) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }
  return { path: workspacePath, markerPath, marker };
}

export function markReviewWorkspaceActive(
  workspace: ReviewWorkspace,
  runtimePid: number | undefined
): void {
  if (typeof runtimePid !== "number") return;
  workspace.marker.runtime_pid = runtimePid;
  workspace.marker.updated_at = new Date().toISOString();
  writeMarker(workspace.markerPath, workspace.marker);
}

function warnCleanupFailure(workspacePath: string, error: unknown): void {
  // Cleanup must never replace the runtime's actual result or error.
  console.warn(
    `[review-runner] Failed to remove disposable workspace ${workspacePath}:`,
    error
  );
}

/** Only use while spawnRuntime is still setting up and cannot return a handle. */
export function removeReviewWorkspaceBeforeStart(workspacePath: string): void {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch (error) {
    warnCleanupFailure(workspacePath, error);
  }
}

export async function removeReviewWorkspace(workspacePath: string): Promise<void> {
  try {
    await rm(workspacePath, { recursive: true, force: true });
  } catch (error) {
    warnCleanupFailure(workspacePath, error);
  }
}
