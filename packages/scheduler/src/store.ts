import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { workflowsDir } from "hotpath-compiler";
import {
  schedulesFileSchema,
  type Schedule,
  type SchedulesFile,
} from "hotpath-shared";

import { checkCron, systemTimeZone } from "./cron.js";
import { checkInputValue } from "./inputs.js";
import { statePaths } from "./paths.js";

// Same rule as the runtime: input names become `--<name>` agent flags.
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export async function loadSchedules(stateDir: string): Promise<Schedule[]> {
  const file = statePaths(stateDir).schedules;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let data: SchedulesFile;
  try {
    data = schedulesFileSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `${file} is not a valid schedules file (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — fix or delete it`,
    );
  }
  return data.schedules;
}

export async function saveSchedules(
  stateDir: string,
  schedules: Schedule[],
): Promise<void> {
  const file = statePaths(stateDir).schedules;
  await mkdir(stateDir, { recursive: true });
  const body: SchedulesFile = { version: 1, schedules };
  // temp + rename: the daemon re-reads this file and must never see half of it
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(schedulesFileSchema.parse(body), null, 2) + "\n",
  );
  await rename(tmp, file);
}

export interface AddScheduleOptions {
  task: string;
  cron: string;
  timezone?: string;
  inputs?: Record<string, string>;
  allowSideEffects?: boolean;
  fallback?: Schedule["fallback"];
  /** test hooks */
  now?: Date;
  workflowExists?: (task: string) => boolean;
}

function defaultWorkflowExists(task: string): boolean {
  return existsSync(path.join(workflowsDir, `${task}.json`));
}

export async function addSchedule(
  stateDir: string,
  options: AddScheduleOptions,
): Promise<Schedule> {
  const exists = options.workflowExists ?? defaultWorkflowExists;
  if (!exists(options.task)) {
    throw new Error(
      `no workflow for task "${options.task}" (workflows/${options.task}.json) — record and compile it first: hotpath compile ${options.task}`,
    );
  }
  const timezone = options.timezone ?? systemTimeZone();
  checkCron(options.cron, timezone);
  const inputs = options.inputs ?? {};
  for (const [name, value] of Object.entries(inputs)) {
    if (!INPUT_NAME_RE.test(name)) {
      throw new Error(
        `invalid input name ${JSON.stringify(name)} — use letters, digits, "_" and "-", starting with a letter or "_"`,
      );
    }
    checkInputValue(name, value);
  }

  const schedules = await loadSchedules(stateDir);
  const ids = new Set(schedules.map((s) => s.id));
  let id: string;
  do {
    id = `${options.task}-${randomBytes(2).toString("hex")}`;
  } while (ids.has(id));

  const schedule: Schedule = {
    id,
    task: options.task,
    cron: options.cron,
    timezone,
    inputs,
    enabled: true,
    sideEffects: options.allowSideEffects ? "allow" : "dry-run",
    fallback: options.fallback ?? "notify",
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  await saveSchedules(stateDir, [...schedules, schedule]);
  return schedule;
}

async function update(
  stateDir: string,
  id: string,
  change: (s: Schedule) => Schedule | null,
): Promise<Schedule> {
  const schedules = await loadSchedules(stateDir);
  const found = schedules.find((s) => s.id === id);
  if (!found) {
    const known = schedules.map((s) => s.id).join(", ") || "(none)";
    throw new Error(`no schedule with id "${id}" — schedules: ${known}`);
  }
  const next = schedules.flatMap((s) => {
    if (s.id !== id) return [s];
    const changed = change(s);
    return changed ? [changed] : [];
  });
  await saveSchedules(stateDir, next);
  return found;
}

export function removeSchedule(
  stateDir: string,
  id: string,
): Promise<Schedule> {
  return update(stateDir, id, () => null);
}

export function setScheduleEnabled(
  stateDir: string,
  id: string,
  enabled: boolean,
): Promise<Schedule> {
  return update(stateDir, id, (s) => ({ ...s, enabled }));
}
