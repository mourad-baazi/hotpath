import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import type { RunMetrics } from "hotpath-runtime";
import type { RunRecord, Schedule } from "hotpath-shared";

import { latestSlot, nextRun } from "./cron.js";
import { appendRun } from "./history.js";
import { resolveInputs } from "./inputs.js";
import { acquireLock } from "./lock.js";
import { loadConfig, notifyRun } from "./notify.js";
import { statePaths } from "./paths.js";
import { loadSchedules } from "./store.js";
import { table } from "./stats.js";

/** A missed slot older than this is skipped instead of caught up. */
export const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;

export interface RunRequest {
  task: string;
  inputs: Record<string, string>;
  dryRun: boolean;
  noFallback: boolean;
}

/** Runs one workflow; throws a DriftError (name "DriftError") on drift. */
export type TaskRunner = (request: RunRequest) => Promise<RunMetrics>;

export interface SchedulerDeps {
  stateDir: string;
  runner: TaskRunner;
  now?: () => Date;
  log?: (message: string) => void;
  /** defaults to the channels in .hotpath/config.json */
  notify?: (run: RunRecord) => Promise<void>;
}

type DriftLike = Error & { metrics?: RunMetrics };

function isDrift(err: unknown): err is DriftLike {
  return err instanceof Error && err.name === "DriftError";
}

/**
 * Decides what is due and runs it. Time and the runtime are injected, so the
 * daemon loop below is only a timer around `tick()`.
 */
export class Scheduler {
  private schedules: Schedule[] = [];
  private schedulesMtime = -1;
  private cursors: Record<string, string> = {};
  private cursorsLoaded = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** Re-read schedules.json when it changed since the last look. */
  async reload(): Promise<Schedule[]> {
    const file = statePaths(this.deps.stateDir).schedules;
    let mtime = 0;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== this.schedulesMtime) {
      const first = this.schedulesMtime === -1;
      this.schedules = await loadSchedules(this.deps.stateDir);
      this.schedulesMtime = mtime;
      if (!first) this.log(`schedules reloaded (${this.schedules.length})`);
    }
    return this.schedules;
  }

  private async loadCursors(): Promise<void> {
    if (this.cursorsLoaded) return;
    this.cursorsLoaded = true;
    try {
      const raw = JSON.parse(
        await readFile(statePaths(this.deps.stateDir).cursor, "utf8"),
      ) as { cursors?: Record<string, string> };
      this.cursors = raw.cursors ?? {};
    } catch {
      this.cursors = {};
    }
  }

  private async saveCursors(): Promise<void> {
    await mkdir(this.deps.stateDir, { recursive: true });
    await writeFile(
      statePaths(this.deps.stateDir).cursor,
      JSON.stringify({ cursors: this.cursors }, null, 2) + "\n",
    );
  }

  /** Start every due run (without waiting for them); resolves once they're started. */
  async tick(): Promise<void> {
    const now = this.now();
    const schedules = await this.reload();
    await this.loadCursors();
    for (const schedule of schedules) {
      const cursor = new Date(this.cursors[schedule.id] ?? schedule.createdAt);
      this.cursors[schedule.id] = now.toISOString();
      if (!schedule.enabled) continue;
      const slot = latestSlot(schedule.cron, schedule.timezone, cursor, now);
      if (!slot) continue;
      if (now.getTime() - slot.getTime() > CATCH_UP_WINDOW_MS) {
        this.log(
          `${schedule.id}: missed the ${slot.toISOString()} run by more than 1h, skipping it`,
        );
        continue;
      }
      if (this.running.has(schedule.id)) {
        this.log(
          `${schedule.id}: still running from the previous slot, skipping ${slot.toISOString()}`,
        );
        await this.record({
          scheduleId: schedule.id,
          task: schedule.task,
          startedAt: now.toISOString(),
          durationMs: 0,
          status: "skipped",
          llmCalls: 0,
          costUsd: 0,
          fallback: false,
          sideEffectsMode: schedule.sideEffects,
          error: "previous run still in progress",
        });
        continue;
      }
      const run = this.execute(schedule).finally(() =>
        this.running.delete(schedule.id),
      );
      this.running.set(schedule.id, run);
    }
    // forget schedules that were removed
    const ids = new Set(schedules.map((s) => s.id));
    for (const id of Object.keys(this.cursors)) {
      if (!ids.has(id)) delete this.cursors[id];
    }
    await this.saveCursors();
  }

  /** Resolves when every started run has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()]);
    }
  }

  get activeRuns(): number {
    return this.running.size;
  }

  /** Earliest next run across enabled schedules (for the daemon's timer). */
  nextDue(): Date | null {
    const now = this.now();
    let best: Date | null = null;
    for (const s of this.schedules) {
      if (!s.enabled) continue;
      const next = nextRun(s.cron, s.timezone, now);
      if (next && (!best || next < best)) best = next;
    }
    return best;
  }

  summary(): string {
    if (this.schedules.length === 0) {
      return 'no schedules yet — add one with: hotpath schedule add <task> --cron "0 7 * * *"';
    }
    const now = this.now();
    return table(
      ["id", "task", "cron", "next run", "enabled"],
      this.schedules.map((s) => [
        s.id,
        s.task,
        `${s.cron} (${s.timezone})`,
        s.enabled
          ? (nextRun(s.cron, s.timezone, now)?.toISOString() ?? "never")
          : "-",
        s.enabled ? "yes" : "no",
      ]),
    );
  }

  private async execute(schedule: Schedule): Promise<void> {
    const started = this.now();
    const inputs = resolveInputs(schedule.inputs, started, schedule.timezone);
    const dryRun = schedule.sideEffects === "dry-run";
    this.log(
      `▶ ${schedule.id}: running ${schedule.task}${dryRun ? " (side effects: dry-run)" : ""}`,
    );
    const base = {
      scheduleId: schedule.id,
      task: schedule.task,
      startedAt: started.toISOString(),
      sideEffectsMode: schedule.sideEffects,
    };
    let record: RunRecord;
    try {
      const metrics = await this.deps.runner({
        task: schedule.task,
        inputs,
        dryRun,
        // "notify" and "off" never start the agent
        noFallback: schedule.fallback !== "auto",
      });
      record = {
        ...base,
        durationMs: metrics.durationMs,
        status: "ok",
        llmCalls: metrics.llmCalls,
        costUsd: metrics.costUsd,
        fallback: metrics.fallback,
      };
    } catch (err) {
      const metrics = isDrift(err) ? err.metrics : undefined;
      record = {
        ...base,
        durationMs:
          metrics?.durationMs ?? this.now().getTime() - started.getTime(),
        status:
          isDrift(err) && schedule.fallback !== "off" ? "drift" : "failed",
        llmCalls: metrics?.llmCalls ?? 0,
        costUsd: metrics?.costUsd ?? 0,
        fallback: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.log(
      `${record.status === "ok" ? "✓" : "✗"} ${schedule.id}: ${record.status}` +
        (record.error ? ` — ${record.error}` : ""),
    );
    await this.record(record);
    if (record.status === "drift" || record.status === "failed") {
      try {
        await (
          this.deps.notify ??
          (async (run) => notifyRun(await loadConfig(this.deps.stateDir), run))
        )(record);
      } catch (err) {
        this.log(
          `[notify] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async record(run: RunRecord): Promise<void> {
    try {
      await appendRun(this.deps.stateDir, run);
    } catch (err) {
      this.log(`could not write run history: ${(err as Error).message}`);
    }
  }
}

/** `hotpath run-due --once`: run whatever is due now, wait for it, exit. */
export async function runDueOnce(deps: SchedulerDeps): Promise<void> {
  await mkdir(deps.stateDir, { recursive: true });
  const release = await acquireLock(statePaths(deps.stateDir).lock);
  try {
    const scheduler = new Scheduler(deps);
    await scheduler.tick();
    await scheduler.idle();
  } finally {
    await release();
  }
}

export interface DaemonHandle {
  /** finish runs in progress, write state, release the lock */
  stop(): Promise<void>;
  done: Promise<void>;
}

/** `hotpath daemon`: foreground loop until stop() (Ctrl+C / SIGTERM in the CLI). */
export async function startDaemon(
  deps: SchedulerDeps & { maxSleepMs?: number },
): Promise<DaemonHandle> {
  await mkdir(deps.stateDir, { recursive: true });
  const release = await acquireLock(statePaths(deps.stateDir).lock);
  const log = deps.log ?? ((m: string) => console.log(m));
  const scheduler = new Scheduler(deps);
  await scheduler.reload();
  log(scheduler.summary());

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  const maxSleep = deps.maxSleepMs ?? 15_000;

  const loop = async () => {
    if (stopped) return;
    try {
      await scheduler.tick();
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopped) return;
    // wake for the next slot, but at least every maxSleep to notice edits
    const next = scheduler.nextDue();
    const now = (deps.now ?? (() => new Date()))().getTime();
    const delay = next
      ? Math.min(maxSleep, Math.max(250, next.getTime() - now + 50))
      : maxSleep;
    timer = setTimeout(loop, delay);
  };
  await loop();

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (scheduler.activeRuns > 0) {
        log(`waiting for ${scheduler.activeRuns} run(s) to finish…`);
      }
      await scheduler.idle();
      await release();
      log("daemon stopped");
      resolveDone();
    })());
  return { stop, done };
}
