import { describe, expect, it } from "vitest";

import {
  workflowSchema,
  type TraceFile,
  type TraceToolCall,
  type Workflow,
} from "hotpath-shared";

import {
  compileTrace,
  formatWorkflow,
  inferCommonSchema,
} from "../src/index.js";

const emails = [
  { id: "e1", from: "alice@corp.com", subject: "Q3 budget review moved" },
  { id: "e2", from: "bob@corp.com", subject: "Offsite agenda draft" },
  { id: "e3", from: "news@city.io", subject: "Metro line 4 closed" },
];

let seq = 0;
function call(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): TraceToolCall {
  seq++;
  return {
    type: "tool_call",
    seq,
    tool,
    args,
    result,
    isError: false,
    startedAt: "2026-10-01T07:00:00.000Z",
    durationMs: 5,
  };
}

function trace(calls: TraceToolCall[]): TraceFile {
  return {
    meta: {
      type: "meta",
      version: 1,
      task: "triage",
      startedAt: "2026-10-01T07:00:00.000Z",
      server: "demo",
      inputs: { date: "2026-10-01" },
      tools: [
        {
          name: "get_emails",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_email",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_weather",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        {
          name: "send_message",
          inputSchema: {},
          annotations: { readOnlyHint: false },
        },
      ],
    },
    calls,
    end: {
      type: "end",
      endedAt: "2026-10-01T07:00:05.000Z",
      toolCalls: calls.length,
    },
  };
}

const body = (
  e: (typeof emails)[number],
  extra: Record<string, unknown> = {},
) => ({
  id: e.id,
  body: `Full text of ${e.subject}`,
  ...extra,
});

function compile(calls: TraceToolCall[]): Workflow {
  return workflowSchema.parse(
    compileTrace(trace(calls), "traces/triage/x.jsonl"),
  );
}

describe("foreach detection", () => {
  it("compiles one call per list item into a foreach", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails.map((e) =>
        call("get_email", { id: e.id, format: "full" }, body(e)),
      ),
    ]);
    expect(wf.steps.map((s) => s.type)).toEqual(["tool", "foreach"]);
    const loop = wf.steps[1]!;
    expect(loop).toMatchObject({
      id: "s2",
      type: "foreach",
      over: "{{steps.s1.result.emails}}",
      as: "email",
      maxItems: 50,
      body: [
        {
          id: "s2.1",
          type: "tool",
          tool: "get_email",
          args: { id: "{{email.id}}", format: "full" },
          sideEffect: false,
        },
      ],
    });
  });

  it("keeps plain steps when the calls cover only part of the list", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails
        .slice(0, 2)
        .map((e) => call("get_email", { id: e.id }, body(e))),
    ]);
    expect(wf.steps.map((s) => s.type)).toEqual(["tool", "tool", "tool"]);
  });

  it("keeps plain steps when the calls are out of order", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...[emails[1]!, emails[0]!, emails[2]!].map((e) =>
        call("get_email", { id: e.id }, body(e)),
      ),
    ]);
    expect(wf.steps.some((s) => s.type === "foreach")).toBe(false);
  });

  it("keeps plain steps when different tools are mixed in", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      call("get_email", { id: "e1" }, body(emails[0]!)),
      call("get_weather", { city: "Paris" }, { tempC: 18 }),
      call("get_email", { id: "e2" }, body(emails[1]!)),
      call("get_email", { id: "e3" }, body(emails[2]!)),
    ]);
    expect(wf.steps.some((s) => s.type === "foreach")).toBe(false);
  });

  it("keeps plain steps when a varying argument does not come from the item", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails.map((e, i) =>
        call("get_email", { id: e.id, note: `n${i}` }, body(e)),
      ),
    ]);
    expect(wf.steps.some((s) => s.type === "foreach")).toBe(false);
  });

  it("an llm summary after the loop reads {{steps.<loop>.results}}", () => {
    const summary =
      "Today: Q3 budget review moved; Offsite agenda draft; Metro line 4 closed. Plan accordingly.";
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails.map((e) => call("get_email", { id: e.id }, body(e))),
      call("send_message", { to: "me", text: summary }, { ok: true }),
    ]);
    expect(wf.steps.map((s) => `${s.id}:${s.type}`)).toEqual([
      "s1:tool",
      "s2:foreach",
      "s3:llm",
      "s4:tool",
    ]);
    const llm = wf.steps[2]!;
    if (llm.type !== "llm") throw new Error("expected llm");
    expect(llm.prompt).toContain("{{steps.s2.results}}");
    expect(llm.guard.grounding?.flatMap((g) => g.paths)).toContain(
      "steps.s1.result.emails.0.subject",
    );
  });

  it("is deterministic", () => {
    const calls = [
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails.map((e) => call("get_email", { id: e.id }, body(e))),
    ];
    expect(compile(calls)).toEqual(compile(calls));
  });

  it("hotpath show prints the loop with an indented body", () => {
    const wf = compile([
      call("get_emails", { date: "2026-10-01" }, { emails }),
      ...emails.map((e) => call("get_email", { id: e.id }, body(e))),
    ]);
    expect(formatWorkflow(wf)).toBe(
      [
        "s1 tool get_emails(date={{inputs.date}})",
        "s2 foreach email in {{steps.s1.result.emails}} (max 50)",
        "  s2.1 tool get_email(id={{email.id}})",
      ].join("\n"),
    );
  });

  it("per-item guards only require what every iteration returned", () => {
    expect(inferCommonSchema([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(inferCommonSchema([1, "x"])).toEqual({});
  });
});
