import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/template.js";

const ctx = {
  inputs: { date: "2026-10-01", limit: 3 },
  steps: {
    s1: { result: { emails: [{ id: "e1", from: "a@b.c" }] } },
    s4: { output: "the brief text" },
  },
};

describe("renderTemplate (SPEC §5.2)", () => {
  it("exactly-one-template keeps the original type", () => {
    expect(renderTemplate("{{inputs.limit}}", ctx)).toBe(3);
    expect(renderTemplate("{{inputs.date}}", ctx)).toBe("2026-10-01");
    expect(renderTemplate("{{steps.s1.result}}", ctx)).toEqual({
      emails: [{ id: "e1", from: "a@b.c" }],
    });
    expect(renderTemplate("{{steps.s4.output}}", ctx)).toBe("the brief text");
  });

  it("resolves json paths into results", () => {
    expect(renderTemplate("{{steps.s1.result.emails.0.id}}", ctx)).toBe("e1");
    expect(renderTemplate("{{steps.s1.result.emails.0.from}}", ctx)).toBe(
      "a@b.c",
    );
  });

  it("interpolates inside longer strings (non-strings JSON-stringified)", () => {
    expect(renderTemplate("date={{inputs.date}}", ctx)).toBe("date=2026-10-01");
    expect(renderTemplate("ids: {{steps.s1.result}}", ctx)).toBe(
      'ids: {"emails":[{"id":"e1","from":"a@b.c"}]}',
    );
  });

  it("renders nested args structures", () => {
    expect(
      renderTemplate({ d: "{{inputs.date}}", n: ["{{inputs.limit}}"] }, ctx),
    ).toEqual({ d: "2026-10-01", n: [3] });
  });
});
