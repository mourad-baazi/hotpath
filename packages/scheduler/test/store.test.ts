import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schedulesFileSchema } from "hotpath-shared";

import {
  addSchedule,
  loadSchedules,
  removeSchedule,
  setScheduleEnabled,
} from "../src/store.js";

let stateDir: string;
const exists = () => true;
const now = new Date("2026-10-01T06:00:00Z");

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "hotpath-sched-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("schedule store", () => {
  it("adds a schedule with safe defaults", async () => {
    const s = await addSchedule(stateDir, {
      task: "brief",
      cron: "0 7 * * 1-5",
      timezone: "Europe/Paris",
      inputs: { date: "@today" },
      now,
      workflowExists: exists,
    });
    expect(s).toMatchObject({
      task: "brief",
      cron: "0 7 * * 1-5",
      timezone: "Europe/Paris",
      inputs: { date: "@today" },
      enabled: true,
      sideEffects: "dry-run",
      fallback: "notify",
      createdAt: now.toISOString(),
    });
    expect(s.id).toMatch(/^brief-[0-9a-f]{4}$/);
    expect(await loadSchedules(stateDir)).toEqual([s]);
  });

  it("--allow-side-effects and --fallback are stored", async () => {
    const s = await addSchedule(stateDir, {
      task: "brief",
      cron: "*/5 * * * *",
      allowSideEffects: true,
      fallback: "auto",
      workflowExists: exists,
    });
    expect(s.sideEffects).toBe("allow");
    expect(s.fallback).toBe("auto");
    expect(s.timezone.length).toBeGreaterThan(0); // system tz
  });

  it("removes, disables and enables by id", async () => {
    const a = await addSchedule(stateDir, {
      task: "a",
      cron: "0 7 * * *",
      workflowExists: exists,
    });
    const b = await addSchedule(stateDir, {
      task: "b",
      cron: "0 8 * * *",
      workflowExists: exists,
    });
    await setScheduleEnabled(stateDir, a.id, false);
    expect(
      (await loadSchedules(stateDir)).find((s) => s.id === a.id)!.enabled,
    ).toBe(false);
    await setScheduleEnabled(stateDir, a.id, true);
    expect(
      (await loadSchedules(stateDir)).find((s) => s.id === a.id)!.enabled,
    ).toBe(true);
    await removeSchedule(stateDir, a.id);
    expect((await loadSchedules(stateDir)).map((s) => s.id)).toEqual([b.id]);
    await expect(removeSchedule(stateDir, "nope")).rejects.toThrow(
      /no schedule with id "nope"/,
    );
  });

  it("refuses an invalid cron, an invalid time zone and a missing workflow", async () => {
    await expect(
      addSchedule(stateDir, {
        task: "a",
        cron: "every morning",
        workflowExists: exists,
      }),
    ).rejects.toThrow(/invalid cron "every morning"/);
    await expect(
      addSchedule(stateDir, {
        task: "a",
        cron: "0 7 * * *",
        timezone: "Mars/Olympus",
        workflowExists: exists,
      }),
    ).rejects.toThrow(/unknown time zone "Mars\/Olympus"/);
    await expect(
      addSchedule(stateDir, {
        task: "missing",
        cron: "0 7 * * *",
        workflowExists: () => false,
      }),
    ).rejects.toThrow(
      /no workflow for task "missing".*hotpath compile missing/,
    );
    expect(await loadSchedules(stateDir)).toEqual([]);
  });

  it("refuses unknown @-inputs and unsafe input names", async () => {
    await expect(
      addSchedule(stateDir, {
        task: "a",
        cron: "0 7 * * *",
        inputs: { d: "@someday" },
        workflowExists: exists,
      }),
    ).rejects.toThrow(/unknown dynamic value.*@today/);
    await expect(
      addSchedule(stateDir, {
        task: "a",
        cron: "0 7 * * *",
        inputs: { "--x": "1" },
        workflowExists: exists,
      }),
    ).rejects.toThrow(/invalid input name/);
  });

  it("schedules.json round-trips through the schema", async () => {
    await addSchedule(stateDir, {
      task: "a",
      cron: "0 7 * * *",
      inputs: { city: "Paris" },
      workflowExists: exists,
    });
    const raw = JSON.parse(
      await readFile(path.join(stateDir, "schedules.json"), "utf8"),
    );
    expect(schedulesFileSchema.parse(raw)).toEqual(raw);
  });

  it("explains a corrupted schedules.json", async () => {
    await writeFile(
      path.join(stateDir, "schedules.json"),
      '{"version":1,"schedules":[{"id":1}]}',
    );
    await expect(loadSchedules(stateDir)).rejects.toThrow(
      /not a valid schedules file/,
    );
  });
});
