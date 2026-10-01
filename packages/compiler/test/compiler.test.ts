import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  mentions,
  readTrace,
  workflowSchema,
  type Workflow,
} from "hotpath-shared";

import {
  compileTrace,
  formatWorkflow,
  lostReadOnlySteps,
} from "../src/index.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/morning-brief.jsonl",
);

async function compileFixture(): Promise<Workflow> {
  const trace = await readTrace(fixture);
  return workflowSchema.parse(
    compileTrace(trace, "traces/morning-brief/fixture.jsonl"),
  );
}

describe("compiler (fixture trace)", () => {
  it("produces a workflow that validates against the schema", async () => {
    const wf = await compileFixture();
    expect(wf.version).toBe(1);
    expect(wf.task).toBe("morning-brief");
    expect(wf.server).toBe("pnpm --silent --filter demo-tools start");
    expect(wf.inputs.date).toEqual({ type: "string", example: "2026-10-01" });
  });

  it("templates input args and keeps constants", async () => {
    const wf = await compileFixture();
    const byId = Object.fromEntries(wf.steps.map((s) => [s.id, s]));

    const emails = byId.s1;
    expect(emails.type).toBe("tool");
    if (emails.type === "tool") {
      expect(emails.args).toEqual({ date: "{{inputs.date}}" });
      expect(emails.sideEffect).toBe(false);
    }

    const weather = byId.s3;
    if (weather.type === "tool") {
      expect(weather.args.city).toBe("Paris"); // constant
      expect(weather.args.date).toBe("{{inputs.date}}");
    }

    const send = byId.s5;
    if (send.type === "tool") {
      expect(send.args.to).toBe("me"); // constant
      expect(send.args.text).toBe("{{steps.s4.output}}");
      expect(send.sideEffect).toBe(true);
    }
  });

  it("inserts exactly one llm step feeding send_message.text", async () => {
    const wf = await compileFixture();
    const llmSteps = wf.steps.filter((s) => s.type === "llm");
    expect(llmSteps).toHaveLength(1);
    const llm = llmSteps[0];
    expect(llm.id).toBe("s4"); // just before send_message
    if (llm.type === "llm") {
      expect(llm.model).toBe("cheap");
      expect(llm.example).toContain("Q3 budget review moved to 14:00");
      expect(llm.prompt).toContain("write the `text` for `send_message`");
      // prompt includes earlier read-only results
      expect(llm.prompt).toContain("get_emails");
      expect(llm.prompt).toContain("get_calendar");
      expect(llm.prompt).toContain("get_weather");
      // results are templates, never baked-in recorded data (else new data is ignored)
      expect(llm.prompt).toContain("{{steps.s1.result}}");
      expect(llm.prompt).toContain("{{steps.s2.result}}");
      expect(llm.prompt).toContain("{{steps.s3.result}}");
      expect(llm.prompt).not.toContain("alice@corp.com");
      // constant sibling args tell the model who the text is for
      expect(llm.prompt).toContain(
        'write the `text` for `send_message` (to="me")',
      );
      expect(llm.guard.nonEmpty).toBe(true);
      expect(llm.guard.maxChars).toBeGreaterThanOrEqual(3 * llm.example.length);
    }
    // order: s1..s3 tools, s4 llm, s5 tool
    expect(wf.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("infers guards from recorded results (get_emails requires subject)", async () => {
    const wf = await compileFixture();
    const emails = wf.steps.find(
      (s) => s.type === "tool" && s.tool === "get_emails",
    )!;
    if (emails.type !== "tool") throw new Error("unreachable");
    const schema = emails.guard.schema as {
      type: string;
      properties: { emails: { items: { required: string[] } } };
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.emails.type).toBe("array");
    expect(schema.properties.emails.items.required).toContain("subject");
  });

  it("is deterministic: two compiles are byte-identical", async () => {
    const trace = await readTrace(fixture);
    const a = compileTrace(trace, "traces/morning-brief/fixture.jsonl");
    const b = compileTrace(trace, "traces/morning-brief/fixture.jsonl");
    expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
  });

  it("show format prints readable steps", async () => {
    const wf = await compileFixture();
    const text = formatWorkflow(wf);
    expect(text).toContain("s1 tool get_emails(date={{inputs.date}})");
    expect(text).toContain("s4 llm (cheap) → s5.text");
    expect(text).toContain("s5 tool send_message(");
    expect(text).toContain("to=me");
  });
});

describe("grounding guard (compile time)", () => {
  async function grounding() {
    const wf = await compileFixture();
    const llm = wf.steps.find((s) => s.type === "llm")!;
    return { llm, entries: llm.guard.grounding ?? [] };
  }
  const pathsOf = (
    entries: Array<{ value: unknown; paths: string[] }>,
    v: unknown,
  ) => entries.find((e) => e.value === v)?.paths;

  it("records result values the example output mentions, with where they came from", async () => {
    const { entries } = await grounding();
    expect(pathsOf(entries, "Q3 budget review moved to 14:00")).toEqual([
      "steps.s1.result.emails.0.subject",
    ]);
    expect(pathsOf(entries, "Standup with Platform team")).toEqual([
      "steps.s2.result.events.0.title",
    ]);
    expect(pathsOf(entries, "Paris")).toEqual(["steps.s3.result.city"]);
    expect(pathsOf(entries, 21)).toEqual(["steps.s3.result.highC"]);
    expect(pathsOf(entries, 11)).toEqual(["steps.s3.result.lowC"]);
  });

  it("only records values the example really mentions", async () => {
    const { llm, entries } = await grounding();
    if (llm.type !== "llm") throw new Error("expected an llm step");
    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) expect(mentions(llm.example, e.value)).toBe(true);
  });

  it("skips trivial values (short strings, single digits)", async () => {
    const { entries } = await grounding();
    for (const e of entries) {
      if (typeof e.value === "string")
        expect(e.value.trim().length).toBeGreaterThanOrEqual(4);
      else
        expect(Math.abs(e.value) >= 10 || !Number.isInteger(e.value)).toBe(
          true,
        );
    }
  });

  it("tool steps get no grounding", async () => {
    const wf = await compileFixture();
    for (const s of wf.steps) {
      if (s.type === "tool") expect(s.guard.grounding).toBeUndefined();
    }
  });
});

describe("lostReadOnlySteps (recompile safety)", () => {
  const wf = (steps: Array<[string, boolean]>): Workflow =>
    ({
      version: 1,
      task: "t",
      compiledFrom: "x",
      server: "s",
      inputs: {},
      steps: steps.map(([tool, sideEffect], i) => ({
        id: `s${i + 1}`,
        type: "tool",
        tool,
        args: {},
        sideEffect,
        guard: {},
      })),
    }) as Workflow;

  it("is empty when nothing read-only was dropped", () => {
    const old = wf([
      ["get_a", false],
      ["get_b", false],
      ["send", true],
    ]);
    expect(
      lostReadOnlySteps(
        old,
        wf([
          ["get_b", false],
          ["get_a", false],
          ["send", true],
        ]),
      ),
    ).toEqual([]);
  });

  it("lists read-only tools the new workflow no longer calls", () => {
    const old = wf([
      ["get_a", false],
      ["get_b", false],
      ["send", true],
    ]);
    const next = wf([
      ["get_a", false],
      ["send", true],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual(["get_b"]);
  });

  it("counts repeats: 3 get_commits -> 2 loses one", () => {
    const old = wf([
      ["get_commits", false],
      ["get_commits", false],
      ["get_commits", false],
    ]);
    const next = wf([
      ["get_commits", false],
      ["get_commits", false],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual(["get_commits (1 of 3)"]);
  });

  it("ignores side-effect steps and extra steps in the new workflow", () => {
    const old = wf([
      ["get_a", false],
      ["send", true],
    ]);
    const next = wf([
      ["get_a", false],
      ["get_c", false],
    ]);
    expect(lostReadOnlySteps(old, next)).toEqual([]);
  });
});
