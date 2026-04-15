import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { installLogger } from "./lib/logger";

installLogger();

const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const workerEntry = path.join(process.cwd(), "src", "orchestrator-worker.ts");

let child: ChildProcess | null = null;
let shuttingDown = false;

function startWorker() {
  console.log("[supervisor] Starting orchestrator worker");
  child = spawn(tsxBin, [workerEntry], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    console.log(
      `[supervisor] Worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
    );
    child = null;
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }
    setTimeout(() => {
      if (!shuttingDown) startWorker();
    }, 2000);
  });
}

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] Shutting down on ${signal}`);
  if (child?.pid) {
    try {
      process.kill(child.pid, signal);
      return;
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker();
