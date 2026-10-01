import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunMetrics } from "hotpath-runtime";
import type { RunRecord, Schedule } from "hotpath-shared";

import {
  Scheduler,
  runDueOnce,
  startDaemon,
  type RunRequest,
  type TaskRunner,
} from "../src/daemon.js";
import { readRuns } from "../src/history.js";
import { acquireLock } from "../src/lock.js";
import { saveSchedules } from "../src/store.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "hotpath-daemon-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function metrics(extra: Partial<RunMetrics> = {}): RunMetrics {
  return {
    durationMs: 400,
    llmCalls: 1,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.001,
    fallback: false,
    steps: [],
    connectMs: 1,
    toolMs: 1,
    llmMs: 1,
    rateLimitWaitMs: 0,
    toolCalls: [],
    ...extra,
  };
}

class DriftError extends Error {
  constructor(readonly metrics: RunMetrics) {
    super("drift at s2: guard failed");
    this.name = "DriftError";
  }
}

function schedule(extra: Partial<Schedule> = {}): Schedule {
  return {
    id: "brief-0001",
    task: "brief",
    cron: "0 7 * * *",
    timezone: "UTC",
    inputs: { date: "@today" },
    enabled: true,
    sideEffects: "dry-run",
    fallback: "notify",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

/** A clock the test moves by hand. */
function clock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso: string) => (t = new Date(iso).getTime()),
  };
}

function setup(runner: TaskRunner, start: string) {
  const c = clock(start);
  const logs: string[] = [];
  const notified: RunRecord[] = [];
  const scheduler = new Scheduler({
    stateDir,
    runner,
    now: c.now,
    log: (m) => logs.push(m),
    notify: async (run) => {
      notified.push(run);
    },
  });
  return { c, logs, notified, scheduler };
}

describe("Scheduler", () => {
  it("runs a schedule when its slot passes, once, with resolved inputs and dry-run", async () => {
    await saveSchedules(stateDir, [schedule()]);
    const calls: RunRequest[] = [];
    const { c, scheduler } = setup(async (r) => {
      calls.push(r);
      return metrics();
    }, "2026-10-01T06:59:00Z");

    await scheduler.tick();
    expect(calls).toHaveLength(0);

    c.set("2026-10-01T07:00:05Z");
    await scheduler.tick();
    await scheduler.idle();
    c.set("2026-10-01T07:00:20Z");
    await scheduler.tick(); // same slot: not again
    await scheduler.idle();

    expect(calls).toEqual([
      {
        task: "brief",
        inputs: { date: "2026-10-01" },
        dryRun: true,
        noFallback: true,
      },
    ]);
    const runs = await readRuns(stateDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      scheduleId: "brief-0001",
      status: "ok",
      llmCalls: 1,
      costUsd: 0.001,
      sideEffectsMode: "dry-run",
    });
  });

  it("ignores disabled schedules", async () => {
    await saveSchedules(stateDir, [schedule({ enabled: false })]);
    let ran = 0;
    const { scheduler } = setup(async () => {
      ran++;
      return metrics();
    }, "2026-10-01T07:00:05Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(ran).toBe(0);
  });

  it("skips (and records) a trigger while the previous run is still going", async () => {
    await saveSchedules(stateDir, [schedule({ cron: "* * * * *" })]);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let started = 0;
    const { c, logs, scheduler } = setup(async () => {
      started++;
      await blocked;
      return metrics();
    }, "2026-10-01T07:00:01Z");

    await scheduler.tick();
    c.set("2026-10-01T07:01:01Z");
    await scheduler.tick();
    release();
    await scheduler.idle();

    expect(started).toBe(1);
    expect(logs.some((l) => l.includes("still running"))).toBe(true);
    const statuses = (await readRuns(stateDir)).map((r) => r.status);
    expect(statuses.sort()).toEqual(["ok", "skipped"]);
  });

  it("catches up one missed run under 1h old, and skips older ones", async () => {
    await saveSchedules(stateDir, [
      schedule({ id: "recent", cron: "0 7 * * *" }),
      schedule({ id: "old", cron: "0 5 * * *" }),
    ]);
    const ran: string[] = [];
    const { logs, scheduler } = setup(async (r) => {
      ran.push(r.task);
      return metrics();
    }, "2026-10-01T07:40:00Z");
    // daemon was off since midnight (createdAt): 07:00 is 40m ago, 05:00 is 2h40 ago
    await scheduler.tick();
    await scheduler.idle();
    expect((await readRuns(stateDir)).map((r) => r.scheduleId)).toEqual([
      "recent",
    ]);
    expect(logs.some((l) => l.startsWith("old: missed"))).toBe(true);
  });

  it("only catches up the latest missed slot, once", async () => {
    await saveSchedules(stateDir, [schedule({ cron: "*/10 * * * *" })]);
    let ran = 0;
    const { scheduler } = setup(async () => {
      ran++;
      return metrics();
    }, "2026-10-01T00:55:00Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(ran).toBe(1);
  });

  it("picks up schedules.json changes without restarting", async () => {
    await saveSchedules(stateDir, []);
    const ran: string[] = [];
    const { c, scheduler, logs } = setup(async (r) => {
      ran.push(r.task);
      return metrics();
    }, "2026-10-01T06:00:00Z");
    await scheduler.tick();
    // make sure the mtime moves even on coarse file systems
    await new Promise((r) => setTimeout(r, 20));
    await saveSchedules(stateDir, [
      schedule({ task: "added", createdAt: "2026-10-01T06:00:00Z" }),
    ]);
    c.set("2026-10-01T07:00:01Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(ran).toEqual(["added"]);
    expect(logs).toContain("schedules reloaded (1)");
  });

  it("fallback=auto lets the runtime run the agent; side effects follow the schedule", async () => {
    await saveSchedules(stateDir, [
      schedule({ fallback: "auto", sideEffects: "allow" }),
    ]);
    const calls: RunRequest[] = [];
    const { scheduler } = setup(async (r) => {
      calls.push(r);
      return metrics({ fallback: true });
    }, "2026-10-01T07:00:05Z");
    await scheduler.tick();
    await scheduler.idle();
    expect(calls[0]).toMatchObject({ dryRun: false, noFallback: false });
    expect((await readRuns(stateDir))[0]).toMatchObject({
      status: "ok",
      fallback: true,
    });
  });

  it("fallback=notify marks drift and notifies; fallback=off marks failed", async () => {
    await saveSchedules(stateDir, [
      schedule({ id: "n", fallback: "notify" }),
      schedule({ id: "o", task: "other", fallback: "off" }),
    ]);
    const { scheduler, notified } = setup(async () => {
      throw new DriftError(metrics({ llmCalls: 2, costUsd: 0.002 }));
    }, "2026-10-01T07:00:05Z");
    await scheduler.tick();
    await scheduler.idle();
    const runs = await readRuns(stateDir);
    expect(runs.find((r) => r.scheduleId === "n")).toMatchObject({
      status: "drift",
      llmCalls: 2,
      error: "drift at s2: guard failed",
    });
    expect(runs.find((r) => r.scheduleId === "o")!.status).toBe("failed");
    expect(notified.map((r) => r.status).sort()).toEqual(["drift", "failed"]);
  });

  it("a crash in the runtime is a failed run, never a crashed daemon", async () => {
    await saveSchedules(stateDir, [schedule()]);
    const { scheduler } = setup(async () => {
      throw new Error("server exited");
    }, "2026-10-01T07:00:05Z");
    await scheduler.tick();
    await scheduler.idle();
    expect((await readRuns(stateDir))[0]).toMatchObject({
      status: "failed",
      error: "server exited",
    });
  });
});

describe("lock", () => {
  it("refuses a second daemon and takes over a stale lock", async () => {
    const file = path.join(stateDir, "daemon.lock");
    const release = await acquireLock(file, 111, () => true);
    await expect(acquireLock(file, 222, () => true)).rejects.toThrow(/pid 111/);
    // pid 111 died without cleaning up
    const takeover = await acquireLock(file, 222, () => false);
    expect((await readFile(file, "utf8")).trim()).toBe("222");
    await release(); // 111's release must not remove 222's lock
    expect((await readFile(file, "utf8")).trim()).toBe("222");
    await takeover();
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("run-due refuses to run while a live daemon holds the lock", async () => {
    await writeFile(path.join(stateDir, "daemon.lock"), `${process.ppid}\n`);
    await expect(
      runDueOnce({ stateDir, runner: async () => metrics(), log: () => {} }),
    ).rejects.toThrow(/another Hotpath daemon/);
  });
});

describe("startDaemon", () => {
  it("prints a summary, runs due work, and on stop waits for the run and releases the lock", async () => {
    await saveSchedules(stateDir, [
      schedule({ cron: "* * * * *", createdAt: "2026-10-01T06:59:00Z" }),
    ]);
    const logs: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let finished = false;
    const handle = await startDaemon({
      stateDir,
      now: () => new Date("2026-10-01T07:00:01Z"),
      log: (m) => logs.push(m),
      notify: async () => {},
      runner: async () => {
        await blocked;
        finished = true;
        return metrics();
      },
      maxSleepMs: 50,
    });
    expect(logs[0]).toContain("brief-0001");
    const stopping = handle.stop();
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(logs).toContain("daemon stopped");
    await expect(
      readFile(path.join(stateDir, "daemon.lock"), "utf8"),
    ).rejects.toThrow();
    expect((await readRuns(stateDir)).map((r) => r.status)).toEqual(["ok"]);
  });
});
