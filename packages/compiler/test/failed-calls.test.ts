import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readTrace,
  workflowSchema,
  type TraceFile,
  type Workflow,
} from "hotpath-shared";

import { compileTrace, formatCompileResult } from "../src/index.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

// Recorded from a real Claude Code session via `claude mcp add` + hotpath record
// (fake demo data only). The agent first called the three read tools without
// their required `date` (validation errors), retried correctly, then called
// send_message with `body` instead of `text` (error) before the right call.
async function realTrace() {
  return readTrace(path.join(fixtures, "real-claude-code-trace.jsonl"));
}

const compile = (trace: TraceFile): Workflow =>
  workflowSchema.parse(compileTrace(trace, "fixtures/trace.jsonl"));

describe("real Claude Code trace (failed and retried calls)", () => {
  it("is the trace we think it is: 8 calls, 4 of them errors", async () => {
    const trace = await realTrace();
    expect(trace.calls.map((c) => c.tool)).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
      "get_emails",
      "get_calendar",
      "get_weather",
      "send_message",
      "send_message",
    ]);
    expect(trace.calls.filter((c) => c.isError)).toHaveLength(4);
  });

  it("compiles to exactly: 3 reads, one llm step, one send_message with text", async () => {
    const wf = compile(await realTrace());

    expect(wf.steps.map((s) => (s.type === "tool" ? s.tool : "llm"))).toEqual([
      "get_emails",
      "get_calendar",
      "get_weather",
      "llm",
      "send_message",
    ]);
    const [emails, calendar, weather, llm, send] = wf.steps;
    if (
      emails.type !== "tool" ||
      calendar.type !== "tool" ||
      weather.type !== "tool" ||
      send.type !== "tool"
    ) {
      throw new Error("unexpected step types");
    }
    expect(emails.args).toEqual({ date: "{{inputs.date}}" });
    expect(calendar.args).toEqual({ date: "{{inputs.date}}" });
    expect(weather.args).toEqual({ city: "Paris", date: "{{inputs.date}}" });
    expect(llm.type).toBe("llm");
    // the successful call's fields, not the failed `body` attempt
    expect(Object.keys(send.args).sort()).toEqual(["text", "to"]);
    expect(send.args.text).toBe(`{{steps.${llm.id}.output}}`);
    expect(send.sideEffect).toBe(true);
    expect(wf.steps.filter((s) => s.type === "llm")).toHaveLength(1);
  });

  it("the workflow can send a message only once", async () => {
    const wf = compile(await realTrace());
    expect(
      wf.steps.filter((s) => s.type === "tool" && s.tool === "send_message"),
    ).toHaveLength(1);
  });

  it("records which calls were dropped and why", async () => {
    const wf = compile(await realTrace());
    expect(wf.droppedCalls?.map((d) => [d.seq, d.tool, d.reason])).toEqual([
      [1, "get_emails", "retried"],
      [2, "get_calendar", "retried"],
      [3, "get_weather", "retried"],
      [7, "send_message", "retried"],
    ]);
    // trace file lines: meta is line 1, so tool_call seq n sits on line n + 1
    expect(wf.droppedCalls?.map((d) => d.line)).toEqual([2, 3, 4, 8]);
    for (const d of wf.droppedCalls ?? []) {
      expect(d.error).toMatch(/MCP error -32602/);
    }
  });

  it("is deterministic", async () => {
    const a = JSON.stringify(compile(await realTrace()));
    const b = JSON.stringify(compile(await realTrace()));
    expect(a).toBe(b);
  });

  it("the llm step still grounds on data from the kept reads", async () => {
    const wf = compile(await realTrace());
    const llm = wf.steps.find((s) => s.type === "llm");
    if (!llm || llm.type !== "llm") throw new Error("no llm step");
    const refs = (llm.guard.grounding ?? []).flatMap((g) => g.paths);
    // s1..s3 are the successful reads; nothing points at a dropped call
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^steps\.s[123]\.result/);
  });
});

describe("dropping rules", () => {
  async function base() {
    return realTrace();
  }

  it("a failed call that is never retried is dropped too ('failed')", async () => {
    const trace = await base();
    // keep only the first (failed) get_weather: no successful retry exists
    const calls = trace.calls.filter(
      (c) => !(c.tool === "get_weather" && !c.isError),
    );
    const wf = compile({ ...trace, calls });
    expect(
      wf.steps.some((s) => s.type === "tool" && s.tool === "get_weather"),
    ).toBe(false);
    const dropped = wf.droppedCalls?.find((d) => d.tool === "get_weather");
    expect(dropped?.reason).toBe("failed");
  });

  it("successful repeats of the same tool are all kept (3 repos -> 3 calls)", async () => {
    const trace = await base();
    const ok = trace.calls.find((c) => c.tool === "get_weather" && !c.isError)!;
    const calls = [
      ...trace.calls.filter((c) => !c.isError),
      { ...ok, seq: 20, args: { city: "Rome", date: "2026-10-01" } },
    ];
    const wf = compile({ ...trace, calls });
    expect(
      wf.steps.filter((s) => s.type === "tool" && s.tool === "get_weather"),
    ).toHaveLength(2);
    expect(wf.droppedCalls).toBeUndefined();
  });

  it("a trace without errors has no droppedCalls field", async () => {
    const trace = await base();
    const wf = compile({
      ...trace,
      calls: trace.calls.filter((c) => !c.isError),
    });
    expect(wf.droppedCalls).toBeUndefined();
  });
});

describe("formatCompileResult", () => {
  it("mentions dropped calls only when there were some", async () => {
    const wf = compile(await realTrace());
    expect(formatCompileResult(wf)).toBe(
      `compiled 5 steps (dropped 4 failed/retried calls) → workflows/${wf.task}.json (from fixtures/trace.jsonl)`,
    );
    const clean = { ...wf, droppedCalls: undefined };
    expect(formatCompileResult(clean)).toBe(
      `compiled 5 steps → workflows/${wf.task}.json (from fixtures/trace.jsonl)`,
    );
    expect(
      formatCompileResult({ ...wf, droppedCalls: [wf.droppedCalls![0]] }),
    ).toContain("(dropped 1 failed/retried call)");
  });
});
