import { appendFile, mkdir, readFile } from "node:fs/promises";

import { runRecordSchema, type RunRecord } from "hotpath-shared";

import { statePaths } from "./paths.js";

export async function appendRun(
  stateDir: string,
  record: RunRecord,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await appendFile(
    statePaths(stateDir).runs,
    JSON.stringify(runRecordSchema.parse(record)) + "\n",
  );
}

export interface RunFilter {
  task?: string;
  /** most recent N (after filtering) */
  limit?: number;
  /** only runs started at or after this time */
  since?: Date;
}

/** Runs oldest → newest. Lines that don't parse are skipped, not fatal. */
export async function readRuns(
  stateDir: string,
  filter: RunFilter = {},
): Promise<RunRecord[]> {
  let text: string;
  try {
    text = await readFile(statePaths(stateDir).runs, "utf8");
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      runs.push(runRecordSchema.parse(JSON.parse(line)));
    } catch {
      // a torn line from a crash shouldn't hide the rest of the history
    }
  }
  const filtered = runs.filter(
    (r) =>
      (!filter.task || r.task === filter.task) &&
      (!filter.since || Date.parse(r.startedAt) >= filter.since.getTime()),
  );
  return filter.limit !== undefined ? filtered.slice(-filter.limit) : filtered;
}

const UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** "30d", "12h", "2w", "90m" → the instant that long before `now`. */
export function parseSince(value: string, now: Date): Date {
  const match = /^(\d+)([mhdw])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `invalid --since "${value}" — use a number and a unit: 90m, 12h, 30d or 2w`,
    );
  }
  return new Date(now.getTime() - Number(match[1]) * UNITS[match[2]!]!);
}
