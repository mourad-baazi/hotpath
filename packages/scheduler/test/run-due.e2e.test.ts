import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workflowsDir } from "hotpath-compiler";
import type { Workflow } from "hotpath-shared";

import { runDueOnce } from "../src/daemon.js";
import { readRuns } from "../src/history.js";
import { repoRoot } from "../src/paths.js";
import { runtimeRunner } from "../src/runner.js";
import { saveSchedules } from "../src/store.js";

// The real runtime against the demo tools. The workflow has no llm step, so
// no model is ever called (the "mocked llm" of the spec is simply not needed).
const task = `e2e-run-due-${process.pid}`;
const workflowFile = path.join(workflowsDir, `${task}.json`);
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "hotpath-rundue-"));
  const workflow: Workflow = {
    version: 1,
    task,
    compiledFrom: "test",
    server: "demo-tools",
    serverArgv: [
      process.execPath,
      "--import",
      "tsx",
      path.join(repoRoot, "examples/demo-tools/src/index.ts"),
    ],
    cwd: repoRoot,
    inputs: { date: { type: "string", example: "2026-10-01" } },
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get_emails",
        args: { date: "{{inputs.date}}" },
        sideEffect: false,
        guard: {},
      },
      {
        id: "s2",
        type: "tool",
        tool: "send_message",
        args: { to: "me", text: "should not be sent" },
        sideEffect: true,
        guard: {},
      },
    ],
  };
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow, null, 2));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(workflowFile, { force: true });
});

describe("hotpath run-due --once (end to end)", () => {
  it("runs a due schedule through the real runtime in dry-run mode and records it", async () => {
    // stay clear of a minute boundary, so the second call sees no new slot
    const secs = new Date().getUTCSeconds();
    if (secs > 50) await new Promise((r) => setTimeout(r, (61 - secs) * 1000));
    const now = new Date();
    await saveSchedules(stateDir, [
      {
        id: `${task}-1`,
        task,
        cron: "* * * * *",
        timezone: "UTC",
        inputs: { date: "@today" },
        enabled: true,
        sideEffects: "dry-run",
        fallback: "off",
        // created two minutes ago, so the last minute's slot is due
        createdAt: new Date(now.getTime() - 120_000).toISOString(),
      },
    ]);
    await runDueOnce({ stateDir, runner: runtimeRunner, log: () => {} });
    const runs = await readRuns(stateDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task,
      status: "ok",
      llmCalls: 0,
      sideEffectsMode: "dry-run",
    });

    // a second call in the same minute has nothing due
    await runDueOnce({ stateDir, runner: runtimeRunner, log: () => {} });
    expect(await readRuns(stateDir)).toHaveLength(1);
  }, 30_000);
});
