import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime } from "./types";

export const REVIEW_WORKSPACE_PREFIX = "review-";
export const REVIEW_WORKSPACE_MARKER = ".cortex-city-review-workspace.json";

export interface ReviewWorkspace {
  path: string;
  markerPath: string;
  marker: ReviewWorkspaceMarker;
  disposable: boolean;
}

type ReviewWorkspaceEnv = Readonly<Record<string, string | undefined>>;

interface ReviewWorkspaceMarker {
  schema_version: 1;
  owner: "cortex-city";
  purpose: "review-runtime";
  review_key?: string;
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

function readMarker(markerPath: string): ReviewWorkspaceMarker | undefined {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    if (
      marker?.schema_version !== 1 ||
      marker?.owner !== "cortex-city" ||
      marker?.purpose !== "review-runtime"
    ) {
      return undefined;
    }
    return marker as ReviewWorkspaceMarker;
  } catch {
    return undefined;
  }
}

function reviewWorkspaceName(reviewKey: string): string {
  const digest = createHash("sha256").update(reviewKey).digest("hex");
  return `${REVIEW_WORKSPACE_PREFIX}${digest}`;
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

export function resolveReviewWorkspacePath(
  reviewKey: string,
  env: ReviewWorkspaceEnv = process.env,
  appRoot = process.cwd()
): string {
  return path.join(
    resolveReviewWorkspaceRoot(env, appRoot),
    reviewWorkspaceName(reviewKey)
  );
}

export function createReviewWorkspace(
  runtime: AgentRuntime,
  reviewKey?: string,
  env: ReviewWorkspaceEnv = process.env,
  appRoot = process.cwd()
): ReviewWorkspace {
  const configuredRoot = resolveReviewWorkspaceRoot(env, appRoot);
  mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(configuredRoot);
  const workspacePath = reviewKey
    ? path.join(root, reviewWorkspaceName(reviewKey))
    : realpathSync(mkdtempSync(path.join(root, `${REVIEW_WORKSPACE_PREFIX}run-`)));
  const workspaceAlreadyExisted = reviewKey ? existsSync(workspacePath) : false;
  if (reviewKey) {
    if (workspaceAlreadyExisted) {
      const entry = lstatSync(workspacePath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Refusing unsafe review workspace ${workspacePath}`);
      }
    } else {
      mkdirSync(workspacePath, { mode: 0o700 });
    }
  }

  const markerPath = path.join(workspacePath, REVIEW_WORKSPACE_MARKER);
  const existing = readMarker(markerPath);
  if (
    (existsSync(markerPath) && !existing) ||
    (reviewKey && workspaceAlreadyExisted && !existsSync(markerPath))
  ) {
    throw new Error(`Refusing unowned review workspace ${workspacePath}`);
  }
  if (existing && existing.review_key !== reviewKey) {
    throw new Error(`Review workspace ownership mismatch at ${workspacePath}`);
  }
  if (existing?.runtime_pid && isProcessRunning(existing.runtime_pid)) {
    throw new Error(`Review workspace is already active at ${workspacePath}`);
  }

  const now = new Date().toISOString();
  const marker: ReviewWorkspaceMarker = {
    schema_version: 1,
    owner: "cortex-city",
    purpose: "review-runtime",
    ...(reviewKey ? { review_key: reviewKey } : {}),
    runtime,
    launcher_pid: process.pid,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  try {
    writeMarker(markerPath, marker);
  } catch (error) {
    if (!workspaceAlreadyExisted) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    path: workspacePath,
    markerPath,
    marker,
    disposable: !reviewKey,
  };
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
    `[review-runner] Failed to clean review workspace ${workspacePath}:`,
    error
  );
}

export function releaseReviewWorkspaceBeforeStart(
  workspace: ReviewWorkspace
): void {
  if (!workspace.disposable) return;
  try {
    rmSync(workspace.path, { recursive: true, force: true });
  } catch (error) {
    warnCleanupFailure(workspace.path, error);
  }
}

export async function releaseReviewWorkspace(
  workspace: ReviewWorkspace,
  runtimePid: number | undefined
): Promise<void> {
  if (workspace.disposable) {
    try {
      await rm(workspace.path, { recursive: true, force: true });
    } catch (error) {
      warnCleanupFailure(workspace.path, error);
    }
    return;
  }

  try {
    const marker = readMarker(workspace.markerPath);
    if (!marker || marker.runtime_pid !== runtimePid) return;
    delete marker.runtime_pid;
    marker.updated_at = new Date().toISOString();
    writeMarker(workspace.markerPath, marker);
    workspace.marker = marker;
  } catch (error) {
    warnCleanupFailure(workspace.path, error);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove a terminal review's workspace only when Cortex ownership is proven. */
export async function removeFinalReviewWorkspace(
  reviewKey: string,
  env: ReviewWorkspaceEnv = process.env,
  appRoot = process.cwd()
): Promise<boolean> {
  const workspacePath = resolveReviewWorkspacePath(reviewKey, env, appRoot);
  if (!existsSync(workspacePath)) return true;

  try {
    const entry = lstatSync(workspacePath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const marker = readMarker(path.join(workspacePath, REVIEW_WORKSPACE_MARKER));
    if (!marker || marker.review_key !== reviewKey) return false;
    if (marker.runtime_pid && isProcessRunning(marker.runtime_pid)) return false;
    await rm(workspacePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    warnCleanupFailure(workspacePath, error);
    return false;
  }
}
