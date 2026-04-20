"use client";

import useSWR from "swr";
import type { CortexGitStatus } from "@/lib/cortex-git";

const fetcher = async (url: string): Promise<CortexGitStatus> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load cortex git status: ${response.status}`);
  }
  return response.json();
};

export function CortexGitStatusIndicator() {
  const { data } = useSWR<CortexGitStatus>("/api/cortex-git", fetcher, {
    refreshInterval: 15_000,
  });

  if (!data) return null;

  if (data.pushing) {
    return (
      <div className="mb-3 rounded-lg border bg-background/70 px-3 py-2 text-xs">
        <div className="text-muted-foreground">
          State snapshots auto-sync to{" "}
          <span className="font-mono text-[11px] text-foreground">
            {data.remoteSlug || data.remoteName || "configured remote"}
          </span>
        </div>
      </div>
    );
  }

  if (!data.enabled) {
    return (
      <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
        State snapshots not synced as `.cortex` is not a git repository.
      </div>
    );
  }

  return null;
}
