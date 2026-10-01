import { loadWorkflow } from "hotpath-compiler";
import { runTask } from "hotpath-runtime";

import type { TaskRunner } from "./daemon.js";
import type { Baseline } from "./stats.js";

/** The real runtime, as the daemon calls it. */
export const runtimeRunner: TaskRunner = (request) =>
  runTask(request.task, {
    inputs: request.inputs,
    dryRun: request.dryRun,
    noFallback: request.noFallback,
  });

/** Agent baselines from the compiled workflows (missing workflow → no baseline). */
export async function loadBaselines(
  tasks: string[],
): Promise<Map<string, Baseline>> {
  const map = new Map<string, Baseline>();
  for (const task of tasks) {
    try {
      map.set(task, (await loadWorkflow(task)).baseline);
    } catch {
      map.set(task, undefined);
    }
  }
  return map;
}
