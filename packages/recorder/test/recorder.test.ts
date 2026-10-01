import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readTrace, type TraceFile } from "hotpath-shared";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const demoToolsEntry = path.join(repoRoot, "examples/demo-tools/src/index.ts");

function demoToolsArgv(): string[] {
  return [process.execPath, "--import", "tsx", demoToolsEntry];
}

async function connectRecorder(task: string, inputs?: Record<string, unknown>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "packages/recorder/src/cli.ts",
      "--task",
      task,
      "--",
      ...demoToolsArgv(),
    ],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(inputs ? { HOTPATH_INPUTS: JSON.stringify(inputs) } : {}),
    },
  });
  const client = new Client({ name: "agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function readLatestTrace(task: string): Promise<TraceFile> {
  const dir = path.join(repoRoot, "traces", task);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  files.sort();
  const file = path.join(dir, files[files.length - 1]);
  // the recorder writes the `end` line as it shuts down; poll until it lands
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const trace = await readTrace(file);
      return trace;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function taskName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe("recorder proxy", () => {
  it("records a full session: meta, 3 tool_calls in order, end", async () => {
    const task = taskName("m3-basic");
    const client = await connectRecorder(task, { date: "2026-10-01" });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);

      const r1 = await client.callTool({
        name: "get_emails",
        arguments: { date: "2026-10-01" },
      });
      const r2 = await client.callTool({
        name: "get_calendar",
        arguments: { date: "2026-10-01" },
      });
      const r3 = await client.callTool({
        name: "get_weather",
        arguments: { city: "Paris", date: "2026-10-01" },
      });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(r3.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const trace = await readLatestTrace(task);
    expect(trace.meta.task).toBe(task);
    expect(trace.meta.inputs).toEqual({ date: "2026-10-01" });
    expect(trace.meta.server).toContain("demo-tools");
    expect(trace.meta.tools.map((t) => t.name).sort()).toEqual([
      "get_calendar",
      "get_emails",
      "get_weather",
      "send_message",
    ]);
    expect(
      trace.meta.tools.find((t) => t.name === "get_emails")?.annotations,
    ).toEqual({
      readOnlyHint: true,
    });

    expect(trace.calls).toHaveLength(3);
    expect(trace.calls.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(trace.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
    ]);
    expect(trace.calls[0].args).toEqual({ date: "2026-10-01" });
    expect(trace.calls[0].result).toHaveProperty("emails");
    expect(trace.calls[1].result).toHaveProperty("events");
    expect(trace.calls[2].result).toMatchObject({ city: "Paris" });
    expect(trace.calls.every((c) => c.isError === false)).toBe(true);
    for (const call of trace.calls) {
      expect(typeof call.startedAt).toBe("string");
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
    }

    expect(trace.end.toolCalls).toBe(3);
    expect(new Date(trace.end.endedAt).getTime()).toBeGreaterThan(
      new Date(trace.meta.startedAt).getTime(),
    );
  });

  it("proxied results deep-equal direct results from demo-tools", async () => {
    const task = taskName("m3-equality");

    const direct = await connectDirectDemoTools();
    let directResult;
    try {
      directResult = await direct.callTool({
        name: "get_emails",
        arguments: { date: "2026-10-01" },
      });
    } finally {
      await direct.close();
    }

    const proxied = await connectRecorder(task);
    let proxiedResult;
    try {
      proxiedResult = await proxied.callTool({
        name: "get_emails",
        arguments: { date: "2026-10-01" },
      });
    } finally {
      await proxied.close();
    }

    expect(proxiedResult).toEqual(directResult);

    const trace = await readLatestTrace(task);
    const directJson = JSON.parse(
      (directResult.content?.find((c) => c.type === "text") as { text: string })
        .text,
    );
    expect(trace.calls[0].result).toEqual(directJson);
  });

  it("forwards tool errors and records them with isError: true", async () => {
    const task = taskName("m3-error");
    const client = await connectRecorder(task);
    let result;
    try {
      result = await client.callTool({
        name: "no_such_tool",
        arguments: {},
      });
    } finally {
      await client.close();
    }

    expect(result.isError).toBe(true);

    const trace = await readLatestTrace(task);
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0].tool).toBe("no_such_tool");
    expect(trace.calls[0].isError).toBe(true);
    expect(trace.end.toolCalls).toBe(1);
  });
});

async function connectDirectDemoTools(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", demoToolsEntry],
    cwd: repoRoot,
    env: { ...process.env },
  });
  const client = new Client({ name: "direct", version: "0.1.0" });
  await client.connect(transport);
  return client;
}
