import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readTrace, workflowSchema, type Workflow } from "hotpath-shared";

import { compileTrace, formatWorkflow } from "../src/index.js";

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
