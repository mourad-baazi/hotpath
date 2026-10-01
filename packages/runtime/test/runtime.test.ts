import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const messagesFile = path.join(repoRoot, "out", "messages.json");
const metricsFile = path.join(repoRoot, "out", "hotpath-run.json");
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

// Mock ONLY chat (never hit the real API); pricing, templates and the MCP
// server underneath run for real — via the recorder proxy, so the executed
// tool-call sequence lands in a trace we can compare against the fixture.
vi.mock("hotpath-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hotpath-shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace } from "hotpath-shared";
import { compileTrace } from "hotpath-compiler";
import { runWorkflow, type RunMetrics } from "../src/index.js";

const chatMock = vi.mocked(chat);
const MOCK_BRIEF = "MOCKED BRIEF TEXT";

const recordTasks: string[] = [];
function taskName(): string {
  const t = `m6-run-${Date.now()}-${recordTasks.length}`;
  recordTasks.push(t);
  return t;
}

// Compile the checked-in fixture trace, then route the workflow's MCP server
// through the recorder proxy (which spawns demo-tools).
async function fixtureWorkflow(task: string) {
  const trace = await readTrace(fixtureTrace);
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  const quote = (s: string) => `"${s}"`;
  workflow.server = [
    quote(process.execPath),
    "--import",
    "tsx",
    "packages/recorder/src/cli.ts",
    "--task",
    task,
    "--",
    quote(process.execPath),
    "--import",
    "tsx",
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  return { workflow, trace };
}

async function readRecordedTrace(task: string) {
  const dir = path.join(repoRoot, "traces", task);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  files.sort();
  const file = path.join(dir, files[files.length - 1]);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await readTrace(file);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await rm(messagesFile, { force: true });
  await rm(metricsFile, { force: true });
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  chatMock.mockReset();
  chatMock.mockResolvedValue({
    text: MOCK_BRIEF,
    toolCalls: [],
    promptTokens: 50,
    completionTokens: 10,
    llmCalls: 1,
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("runtime (mocked llm, real MCP via recorder)", () => {
  it("executes the same tool-call sequence as the trace and writes metrics", async () => {
    const task = taskName();
    const { workflow, trace } = await fixtureWorkflow(task);

    const metrics: RunMetrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
    });

    // summary line
    const summary = logs.find((l) => l.includes("✓"));
    expect(summary).toMatch(
      /^✓ morning-brief in \d+\.\ds, \$0\.\d{4} \(1 llm call\)$/,
    );
    const pin = Number(process.env.PRICE_CHEAP_IN ?? 0.95);
    const pout = Number(process.env.PRICE_CHEAP_OUT ?? 4);
    expect(metrics.costUsd).toBeCloseTo((50 * pin + 10 * pout) / 1e6, 9);

    // metrics file
    const written = JSON.parse(await readFile(metricsFile, "utf8"));
    expect(written).toEqual(metrics);
    expect(metrics.fallback).toBe(false);
    expect(metrics.llmCalls).toBe(1);
    expect(metrics.promptTokens).toBe(50);
    expect(metrics.completionTokens).toBe(10);
    expect(metrics.steps).toHaveLength(5);
    expect(metrics.steps.every((s) => s.ok)).toBe(true);

    // the brief sent via send_message is the mocked llm text
    const messages = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe("me");
    expect(messages[0].text).toBe(MOCK_BRIEF);

    // executed tool-call sequence equals the trace's; the llm-written
    // send_message.text is replaced by fresh llm output, so compare it
    // separately (below).
    const recorded = await readRecordedTrace(task);
    expect(recorded.calls.map((c) => c.tool)).toEqual(
      trace.calls.map((c) => c.tool),
    );
    expect(recorded.calls[0].args).toEqual({ date: "2026-10-01" });
    expect(recorded.calls[1].args).toEqual(trace.calls[1].args);
    expect(recorded.calls[2].args).toEqual(trace.calls[2].args);
    expect(recorded.calls[3].args.to).toBe("me");
    expect(recorded.calls[3].args.text).toBe(MOCK_BRIEF);
  }, 30_000);

  it("--dry-run skips side effects and prints what they would send", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);

    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });

    // nothing written to out/messages.json
    await expect(readFile(messagesFile, "utf8")).rejects.toThrow();
    // but the read-only steps did run (their step entries are ok)
    expect(metrics.steps.filter((s) => s.ok)).toHaveLength(5);
    // and the would-be payload is printed
    const dryLines = logs.filter((l) => l.startsWith("dry-run:"));
    expect(dryLines).toHaveLength(1);
    expect(dryLines[0]).toContain("send_message");
    expect(dryLines[0]).toContain(
      JSON.stringify({ to: "me", text: MOCK_BRIEF }),
    );

    // the recorder saw no send_message either
    const recorded = await readRecordedTrace(task);
    expect(recorded.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
    ]);
  }, 30_000);

  it("missing required input → clear error listing inputs and examples", async () => {
    const task = taskName();
    const { workflow } = await fixtureWorkflow(task);

    await expect(runWorkflow(workflow, { inputs: {} })).rejects.toThrow(
      /missing required input.*date.*2026-10-01/s,
    );
  }, 30_000);
});
