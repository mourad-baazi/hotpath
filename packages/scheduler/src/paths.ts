import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** Where scheduler state lives; tests pass their own temp folder. */
export const defaultStateDir = path.join(repoRoot, ".hotpath");

export function statePaths(stateDir: string) {
  return {
    schedules: path.join(stateDir, "schedules.json"),
    runs: path.join(stateDir, "runs.jsonl"),
    lock: path.join(stateDir, "daemon.lock"),
    config: path.join(stateDir, "config.json"),
    /** last time the daemon checked each schedule (for the catch-up rule) */
    cursor: path.join(stateDir, "scheduler-state.json"),
  };
}
