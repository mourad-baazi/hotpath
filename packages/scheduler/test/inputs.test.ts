import { describe, expect, it } from "vitest";

import { latestSlot, nextRun } from "../src/cron.js";
import {
  checkInputValue,
  resolveInputs,
  resolveInputValue,
} from "../src/inputs.js";

describe("dynamic inputs", () => {
  it("resolves in the schedule's time zone", () => {
    // 23:30 UTC on Oct 1 is already Oct 2 in Paris (UTC+2)
    const now = new Date("2026-10-01T23:30:00Z");
    expect(resolveInputValue("@today", now, "UTC")).toBe("2026-10-01");
    expect(resolveInputValue("@today", now, "Europe/Paris")).toBe("2026-10-02");
    expect(resolveInputValue("@yesterday", now, "Europe/Paris")).toBe(
      "2026-10-01",
    );
    expect(resolveInputValue("@tomorrow", now, "Europe/Paris")).toBe(
      "2026-10-03",
    );
    expect(resolveInputValue("@weekday", now, "UTC")).toBe("thursday");
    expect(resolveInputValue("@weekday", now, "Europe/Paris")).toBe("friday");
    expect(resolveInputValue("@now", now, "Europe/Paris")).toBe(
      "2026-10-01T23:30:00.000Z",
    );
  });

  it("handles the date line: Auckland is a day ahead of Los Angeles", () => {
    const now = new Date("2026-06-15T20:00:00Z");
    expect(resolveInputValue("@today", now, "Pacific/Auckland")).toBe(
      "2026-06-16",
    );
    expect(resolveInputValue("@today", now, "America/Los_Angeles")).toBe(
      "2026-06-15",
    );
    expect(resolveInputValue("@yesterday", now, "Pacific/Auckland")).toBe(
      "2026-06-15",
    );
  });

  it("is right on DST transition days (23- and 25-hour days)", () => {
    // Europe/Paris springs forward on 2026-03-29 and falls back on 2026-10-25
    const spring = new Date("2026-03-29T22:30:00Z"); // 00:30 on Mar 30 in Paris (UTC+2)
    expect(resolveInputValue("@today", spring, "Europe/Paris")).toBe(
      "2026-03-30",
    );
    expect(resolveInputValue("@yesterday", spring, "Europe/Paris")).toBe(
      "2026-03-29",
    );
    const fall = new Date("2026-10-25T22:30:00Z"); // 23:30 on Oct 25 in Paris (UTC+1)
    expect(resolveInputValue("@today", fall, "Europe/Paris")).toBe(
      "2026-10-25",
    );
    expect(resolveInputValue("@tomorrow", fall, "Europe/Paris")).toBe(
      "2026-10-26",
    );
    // US DST ends 2026-11-01
    const us = new Date("2026-11-01T07:30:00Z"); // 00:30 PDT on Nov 1 in LA (PST starts at 09:00Z)
    expect(resolveInputValue("@today", us, "America/Los_Angeles")).toBe(
      "2026-11-01",
    );
  });

  it("passes literals through and rejects unknown @-values", () => {
    expect(
      resolveInputs(
        { city: "Paris", date: "@today" },
        new Date("2026-01-01T12:00:00Z"),
        "UTC",
      ),
    ).toEqual({
      city: "Paris",
      date: "2026-01-01",
    });
    expect(() => checkInputValue("d", "@nextweek")).toThrow(
      /unknown dynamic value/,
    );
    expect(() => checkInputValue("d", "plain")).not.toThrow();
  });
});

describe("cron helpers", () => {
  it("computes next runs in a time zone", () => {
    const next = nextRun(
      "0 7 * * *",
      "Europe/Paris",
      new Date("2026-10-01T06:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-02T05:00:00.000Z"); // 07:00 Paris = 05:00Z
  });

  it("finds the latest slot in a window", () => {
    const after = new Date("2026-10-01T00:00:00Z");
    const now = new Date("2026-10-01T00:31:00Z");
    expect(latestSlot("*/10 * * * *", "UTC", after, now)?.toISOString()).toBe(
      "2026-10-01T00:30:00.000Z",
    );
    expect(latestSlot("0 7 * * *", "UTC", after, now)).toBeNull();
  });
});
