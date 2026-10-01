import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMetrics } from "../src/agent.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const messagesFile = path.join(repoRoot, "out", "messages.json");
const metricsFile = path.join(repoRoot, "out", "agent-run.json");

// Mock ONLY the LLM (never hit the real API in tests); everything else —
// the recorder proxy and the demo-tools server underneath — runs for real.
vi.mock("hotpath-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hotpath-shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat } from "hotpath-shared";

const chatMock = vi.mocked(chat);

function scriptToolCalls() {
  const script = [
    {
      toolCalls: [
        { id: "c1", name: "get_emails", arguments: { date: "2026-10-01" } },
      ],
    },
    {
      toolCalls: [
        { id: "c2", name: "get_calendar", arguments: { date: "2026-10-01" } },
      ],
    },
    {
      toolCalls: [
        {
          id: "c3",
          name: "get_weather",
          arguments: { city: "Paris", date: "2026-10-01" },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "c4",
          name: "send_message",
          arguments: { to: "me", text: "The brief." },
        },
      ],
    },
    { text: "Brief sent." },
  ];
  chatMock.mockImplementation(async () => {
    const step = script.shift();
    if (!step) throw new Error("chat called more times than scripted");
    return {
      text: step.text ?? null,
      toolCalls: step.toolCalls ?? [],
      promptTokens: 100,
      completionTokens: 20,
      llmCalls: 1,
    };
  });
}

describe("demo-agent (mocked llm)", () => {
  beforeEach(async () => {
    await rm(messagesFile, { force: true });
    await rm(metricsFile, { force: true });
    scriptToolCalls();
  });

  afterEach(() => {
    chatMock.mockReset();
  });

  it("runs the tool-use loop through the recorder proxy and writes metrics", async () => {
    const { runAgent } = await import("../src/agent.js");
    const task = "morning-brief";
    const metrics: AgentMetrics = await runAgent({ task, date: "2026-10-01" });

    // metrics file with the right fields
    const written = JSON.parse(await readFile(metricsFile, "utf8"));
    expect(written).toEqual(metrics);
    expect(metrics.llmCalls).toBe(5);
    expect(metrics.promptTokens).toBe(500);
    expect(metrics.completionTokens).toBe(100);
    expect(metrics.durationMs).toBeGreaterThan(0);
    const pin = Number(process.env.PRICE_AGENT_IN ?? 3);
    const pout = Number(process.env.PRICE_AGENT_OUT ?? 15);
    expect(metrics.costUsd).toBeCloseTo((500 * pin + 100 * pout) / 1e6, 9);

    // the loop actually executed the tools through MCP: message on disk…
    const messages = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe("me");
    expect(messages[0].text).toBe("The brief.");

    // …and visible in the recorded trace, in order (recorder finalizes async)
    const { readTrace } = await import("hotpath-shared");
    const traceDir = path.join(repoRoot, "traces", task);
    const files = (await readdir(traceDir)).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    files.sort();
    let trace;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        trace = await readTrace(path.join(traceDir, files[files.length - 1]));
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(trace.meta.inputs).toEqual({ date: "2026-10-01" });
    expect(trace.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
      "send_message",
    ]);
    expect(trace.calls.every((c) => c.isError === false)).toBe(true);
    expect(trace.end.toolCalls).toBe(4);

    // the mock saw the four MCP tools converted to function tools
    const firstCall = chatMock.mock.calls[0][0];
    expect(firstCall.tools?.map((t) => t.name).sort()).toEqual([
      "get_calendar",
      "get_emails",
      "get_weather",
      "send_message",
    ]);
  }, 30_000);
});
