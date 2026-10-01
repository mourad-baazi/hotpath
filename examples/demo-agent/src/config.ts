import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface TaskConfig {
  agent: string;
  server: string;
}

// Minimal shell-word split (handles double quotes; enough for hotpath.config.json).
export function splitCommand(cmd: string): string[] {
  return (cmd.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((w) =>
    w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w,
  );
}

export async function loadTaskConfig(task: string): Promise<TaskConfig> {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, "hotpath.config.json"), "utf8"),
  ) as {
    tasks: Record<string, TaskConfig>;
  };
  const entry = config.tasks[task];
  if (!entry) {
    throw new Error(
      `task "${task}" not found in hotpath.config.json (tasks: ${Object.keys(config.tasks).join(", ")})`,
    );
  }
  return entry;
}
