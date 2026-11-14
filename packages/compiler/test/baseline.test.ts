import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TraceFile } from "hotpath-shared";

import { agentBaseline } from "../src/index.js";

const trace = {
  meta: { startedAt: "2026-10-01T07:00:00.000Z" },
  end: { endedAt: "2026-10-01T07:00:12.500Z" },
} as TraceFile;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-baseline-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function agentRun(costUsd: number, at: string): Promise<string> {
  const file = path.join(dir, "agent-run.json");
  await writeFile(file, JSON.stringify({ costUsd }));
  const t = new Date(at);
  await utimes(file, t, t);
  return file;
}

describe("agentBaseline", () => {
  it("takes the wall time from the trace and the cost written during it", async () => {
    const file = await agentRun(0.042, "2026-10-01T07:00:13Z");
    expect(await agentBaseline(trace, file)).toEqual({
      durationMs: 12_500,
      costUsd: 0.042,
    });
  });

  it("never borrows a cost from another run", async () => {
    const file = await agentRun(0.042, "2026-10-01T09:00:00Z");
    expect(await agentBaseline(trace, file)).toEqual({ durationMs: 12_500 });
  });

  it("works without any agent metrics", async () => {
    expect(await agentBaseline(trace, path.join(dir, "missing.json"))).toEqual({
      durationMs: 12_500,
    });
  });
});
