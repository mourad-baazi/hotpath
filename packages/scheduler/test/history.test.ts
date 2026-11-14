import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunRecord } from "hotpath-shared";

import { appendRun, parseSince, readRuns } from "../src/history.js";
import { buildNotification, notifyRun, postWebhook } from "../src/notify.js";
import { computeStats, formatStats } from "../src/stats.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "hotpath-history-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function run(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    scheduleId: "s",
    task: "brief",
    startedAt: "2026-10-01T07:00:00.000Z",
    durationMs: 500,
    status: "ok",
    llmCalls: 1,
    costUsd: 0.001,
    fallback: false,
    sideEffectsMode: "allow",
    ...extra,
  };
}

describe("run history", () => {
  it("appends runs and filters by task, time and limit", async () => {
    await appendRun(stateDir, run({ startedAt: "2026-09-01T07:00:00.000Z" }));
    await appendRun(stateDir, run({ task: "other" }));
    await appendRun(stateDir, run({ startedAt: "2026-10-02T07:00:00.000Z" }));
    await appendFile(path.join(stateDir, "runs.jsonl"), "{torn line\n");
    expect(await readRuns(stateDir)).toHaveLength(3);
    expect(await readRuns(stateDir, { task: "brief" })).toHaveLength(2);
    expect(
      await readRuns(stateDir, { since: new Date("2026-09-15T00:00:00Z") }),
    ).toHaveLength(2);
    const last = await readRuns(stateDir, { task: "brief", limit: 1 });
    expect(last.map((r) => r.startedAt)).toEqual(["2026-10-02T07:00:00.000Z"]);
  });

  it("parses --since windows", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    expect(parseSince("30d", now).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(parseSince("12h", now).toISOString()).toBe(
      "2026-10-30T12:00:00.000Z",
    );
    expect(parseSince("2w", now).toISOString()).toBe(
      "2026-10-17T00:00:00.000Z",
    );
    expect(parseSince("90m", now).toISOString()).toBe(
      "2026-10-30T22:30:00.000Z",
    );
    expect(() => parseSince("a month", now)).toThrow(/invalid --since/);
  });
});

describe("stats", () => {
  it("computes success rate, cost and estimated savings from the baseline", () => {
    const runs = [
      run({ costUsd: 0.001, durationMs: 1_000 }),
      run({ costUsd: 0.002, durationMs: 2_000 }),
      run({ status: "drift", costUsd: 0.003 }),
      run({ status: "skipped", costUsd: 0 }),
    ];
    const [s] = computeStats(
      runs,
      new Map([["brief", { durationMs: 30_000, costUsd: 0.05 }]]),
    );
    expect(s).toMatchObject({ task: "brief", runs: 3, ok: 2, skipped: 1 });
    expect(s!.successRate).toBeCloseTo(2 / 3);
    expect(s!.workflowCostUsd).toBeCloseTo(0.006);
    expect(s!.estCostSavedUsd).toBeCloseTo(0.05 - 0.001 + 0.05 - 0.002);
    expect(s!.estTimeSavedMs).toBe(29_000 + 28_000);
  });

  it("shows n/a instead of inventing numbers when there is no baseline", () => {
    const stats = computeStats(
      [run({ task: "nobase" }), run({ task: "timeonly" })],
      new Map([
        ["nobase", undefined],
        ["timeonly", { durationMs: 10_000 }],
      ]),
    );
    expect(stats.find((s) => s.task === "nobase")).toMatchObject({
      estCostSavedUsd: null,
      estTimeSavedMs: null,
    });
    expect(stats.find((s) => s.task === "timeonly")).toMatchObject({
      estCostSavedUsd: null,
      estTimeSavedMs: 9_500,
    });
    const text = formatStats(stats, "30d");
    expect(text).toContain("n/a");
    expect(text).toContain("estimate");
  });
});

describe("notifications", () => {
  it("only drift and failed runs notify, with a short one-line reason", () => {
    expect(buildNotification(run())).toBeNull();
    expect(buildNotification(run({ status: "skipped" }))).toBeNull();
    const n = buildNotification(
      run({ status: "drift", error: "guard\nfailed: " + "x".repeat(500) }),
    )!;
    expect(n.title).toBe("Hotpath: brief drifted");
    expect(n.payload.reason.length).toBeLessThanOrEqual(200);
    expect(n.payload.reason).not.toContain("\n");
    expect(n.body).toContain("hotpath runs --task brief");
  });

  async function server(
    handler: (req: IncomingMessage, body: string) => number,
  ) {
    const received: string[] = [];
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(body);
        res.statusCode = handler(req, body);
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
    return { url, received, close: () => new Promise((r) => srv.close(r)) };
  }

  it("posts JSON to the webhook, retrying a 5xx exactly once", async () => {
    let calls = 0;
    const s = await server(() => (++calls === 1 ? 503 : 200));
    await postWebhook(s.url, { a: 1 });
    expect(s.received).toEqual(['{"a":1}', '{"a":1}']);
    await s.close();
  });

  it("gives up after one retry and never retries a 4xx", async () => {
    const s500 = await server(() => 500);
    await expect(postWebhook(s500.url, {})).rejects.toThrow(/HTTP 500/);
    expect(s500.received).toHaveLength(2);
    await s500.close();
    const s400 = await server(() => 400);
    await expect(postWebhook(s400.url, {})).rejects.toThrow(/HTTP 400/);
    expect(s400.received).toHaveLength(1);
    await s400.close();
  });

  it("notifyRun sends to every channel and logs failures instead of throwing", async () => {
    const s = await server(() => 500);
    const desktop: string[] = [];
    const logs: string[] = [];
    await notifyRun(
      { notify: { desktop: true, webhook: s.url } },
      run({ status: "failed", error: "boom" }),
      {
        desktop: async (title) => {
          desktop.push(title);
          throw new Error("no notification daemon");
        },
        log: (m) => logs.push(m),
      },
    );
    expect(desktop).toEqual(["Hotpath: brief failed"]);
    expect(logs.some((l) => l.includes("desktop notification failed"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("webhook failed"))).toBe(true);
    expect(JSON.parse(s.received[0]!)).toMatchObject({
      task: "brief",
      status: "failed",
      reason: "boom",
    });
    await s.close();
  });
});
