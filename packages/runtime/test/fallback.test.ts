import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const metricsFile = path.join(repoRoot, "out", "hotpath-run.json");
const messagesFile = path.join(repoRoot, "out", "messages.json");
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);
const tsxArgs = [process.execPath, "--import", "tsx"];

// Mock ONLY chat; the demo-tools server, recorder, compiler and guards run for real.
vi.mock("hotpath-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hotpath-shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace, workflowSchema, type Workflow } from "hotpath-shared";
import { compileTrace, loadWorkflow } from "hotpath-compiler";
import {
  DriftError,
  runTask,
  type AgentRequest,
  type RunMetrics,
} from "../src/index.js";

const chatMock = vi.mocked(chat);
const MOCK_BRIEF = "MOCKED BRIEF TEXT";
const tasks: string[] = [];
const quote = (s: string) => `"${s}"`;

async function installWorkflow(mutate?: (w: Workflow) => void) {
  const task = `m7-${Date.now()}-${tasks.length}`;
  tasks.push(task);
  const trace = await readTrace(fixtureTrace);
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  workflow.task = task;
  // Straight to demo-tools (no recorder) so only the fake agent writes traces.
  workflow.server = [
    ...tsxArgs.map(quote),
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  mutate?.(workflow);
  await mkdir(path.join(repoRoot, "workflows"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "workflows", `${task}.json`),
    JSON.stringify(workflowSchema.parse(workflow), null, 2),
  );
  return task;
}

// Stand-in for the real LLM agent: does the same four calls through the real
// recorder so a fresh trace lands in traces/<task>/.
function fakeAgent() {
  const calls: AgentRequest[] = [];
  const run = async (req: AgentRequest) => {
    calls.push(req);
    const date = String(req.inputs.date);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "packages/recorder/src/cli.ts",
        "--task",
        req.task,
        "--",
        // plain `node`: the recorder spawns its server through a shell on Windows,
        // where a path with a space (Program Files) would break.
        "node",
        "--import",
        "tsx",
        "examples/demo-tools/src/index.ts",
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        HOTPATH_INPUTS: JSON.stringify(req.inputs),
      } as Record<string, string>,
    });
    const client = new Client({ name: "fake-agent", version: "0.0.0" });
    await client.connect(transport);
    const emails = await client.callTool({
      name: "get_emails",
      arguments: { date },
    });
    await client.callTool({ name: "get_calendar", arguments: { date } });
    await client.callTool({
      name: "get_weather",
      arguments: { city: "Paris", date },
    });
    await client.callTool({
      name: "send_message",
      arguments: { to: "me", text: `Brief: ${JSON.stringify(emails)}` },
    });
    await client.close();
  };
  return { run, calls };
}

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
const savedFixtures = process.env.DEMO_FIXTURES;

beforeEach(async () => {
  await rm(metricsFile, { force: true });
  await rm(messagesFile, { force: true });
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
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
  if (savedFixtures === undefined) delete process.env.DEMO_FIXTURES;
  else process.env.DEMO_FIXTURES = savedFixtures;
});

afterAll(async () => {
  for (const task of tasks) {
    await rm(path.join(repoRoot, "traces", task), {
      recursive: true,
      force: true,
    });
    const files = await readdir(path.join(repoRoot, "workflows"));
    for (const f of files.filter((f) => f.startsWith(`${task}.`))) {
      await rm(path.join(repoRoot, "workflows", f), { force: true });
    }
  }
});

describe("guards + fallback + recompile (M7)", () => {
  it("drift at s1 → agent runs once → recompiled (title required) → next run passes", async () => {
    const task = await installWorkflow();
    process.env.DEMO_FIXTURES = "drift";
    const agent = fakeAgent();

    const metrics: RunMetrics = await runTask(task, {
      inputs: { date: "2026-10-01" },
      runAgent: agent.run,
    });

    expect(logs.some((l) => l.startsWith("⚠ drift at s1:"))).toBe(true);
    expect(logs.join("\n")).toMatch(/drift at s1: .*subject/);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toEqual({
      task,
      inputs: { date: "2026-10-01" },
    });
    expect(metrics.fallback).toBe(true);
    expect(metrics.driftStep).toBe("s1");
    expect(metrics.reason).toMatch(/subject/);
    expect(JSON.parse(await readFile(metricsFile, "utf8"))).toEqual(metrics);

    // old workflow kept as a backup, new one guards on `title`
    const backups = (await readdir(path.join(repoRoot, "workflows"))).filter(
      (f) => f.startsWith(`${task}.`) && f.endsWith(".bak.json"),
    );
    expect(backups).toHaveLength(1);
    const recompiled = await loadWorkflow(task);
    const s1 = recompiled.steps[0];
    const required = JSON.stringify(
      s1.type === "tool" ? s1.guard.schema : null,
    );
    expect(required).toContain('"title"');
    expect(required).not.toContain('"subject"');

    // a subsequent run on the drift fixtures now passes, with no fallback
    const second = await runTask(task, {
      inputs: { date: "2026-10-01" },
      runAgent: agent.run,
    });
    expect(second.fallback).toBe(false);
    expect(second.steps.every((s) => s.ok)).toBe(true);
    expect(agent.calls).toHaveLength(1);
    const messages = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(messages.at(-1).text).toBe(MOCK_BRIEF);
  }, 90_000);

  it("--no-fallback: non-zero (throws DriftError) and the agent is not called", async () => {
    const task = await installWorkflow();
    process.env.DEMO_FIXTURES = "drift";
    const agent = fakeAgent();

    await expect(
      runTask(task, {
        inputs: { date: "2026-10-01" },
        noFallback: true,
        runAgent: agent.run,
      }),
    ).rejects.toBeInstanceOf(DriftError);

    expect(agent.calls).toHaveLength(0);
    const written = JSON.parse(await readFile(metricsFile, "utf8"));
    expect(written.fallback).toBe(false);
    expect(written.driftStep).toBe("s1");
    // nothing was sent, workflow untouched (no backup)
    await expect(readFile(messagesFile, "utf8")).rejects.toThrow();
    const files = await readdir(path.join(repoRoot, "workflows"));
    expect(
      files.filter((f) => f.endsWith(".bak.json") && f.includes(task)),
    ).toHaveLength(0);
  }, 60_000);

  it("never falls back after a side effect already ran (would send twice)", async () => {
    const task = await installWorkflow((w) => {
      // make the send_message step's guard impossible to satisfy
      const send = w.steps[w.steps.length - 1];
      send.guard = { schema: { type: "array" } };
    });
    const agent = fakeAgent();

    await expect(
      runTask(task, { inputs: { date: "2026-10-01" }, runAgent: agent.run }),
    ).rejects.toThrow(/side effect/);

    expect(agent.calls).toHaveLength(0);
    // the message was sent exactly once
    const messages = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(messages).toHaveLength(1);
  }, 60_000);

  it("--dry-run never falls back to the agent", async () => {
    const task = await installWorkflow();
    process.env.DEMO_FIXTURES = "drift";
    const agent = fakeAgent();

    await expect(
      runTask(task, {
        inputs: { date: "2026-10-01" },
        dryRun: true,
        runAgent: agent.run,
      }),
    ).rejects.toBeInstanceOf(DriftError);
    expect(agent.calls).toHaveLength(0);
  }, 60_000);

  it("llm guard failure (empty output) is drift at the llm step", async () => {
    const task = await installWorkflow();
    chatMock.mockResolvedValue({
      text: "   ",
      toolCalls: [],
      promptTokens: 5,
      completionTokens: 1,
      llmCalls: 1,
    });
    const agent = fakeAgent();

    await expect(
      runTask(task, {
        inputs: { date: "2026-10-01" },
        noFallback: true,
        runAgent: agent.run,
      }),
    ).rejects.toMatchObject({ stepId: "s4" });
    // the side-effect step never ran
    await expect(readFile(messagesFile, "utf8")).rejects.toThrow();
  }, 60_000);
});
