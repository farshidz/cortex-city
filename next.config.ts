import { execSync } from "node:child_process";
import type { NextConfig } from "next";

function getCommitSha(): string {
  if (process.env.CORTEX_COMMIT_SHA) return process.env.CORTEX_COMMIT_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;

  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CORTEX_COMMIT_SHA: getCommitSha(),
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
