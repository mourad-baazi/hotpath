import { describe, expect, it } from "vitest";

import { renderTemplate, type TemplateContext } from "../src/template.js";

const ctx: TemplateContext = {
  inputs: { date: "2026-10-01" },
  steps: {
    s1: { result: { emails: [{ id: "e1" }, { id: "e2" }] } },
    s3: { results: [{ subject: "A" }, { subject: "B" }] },
    "s3.1": { result: { subject: "B", body: "text" } },
  },
  vars: { email: { id: "e2", from: { name: "Bob" } } },
};

describe("templates in and after loops", () => {
  it("resolves the loop variable and its fields", () => {
    expect(renderTemplate("{{email.id}}", ctx)).toBe("e2");
    expect(renderTemplate("{{email.from.name}}", ctx)).toBe("Bob");
    expect(renderTemplate("{{email}}", ctx)).toEqual({
      id: "e2",
      from: { name: "Bob" },
    });
    expect(renderTemplate("to {{email.from.name}}", ctx)).toBe("to Bob");
  });

  it("resolves body step ids that contain a dot", () => {
    expect(renderTemplate("{{steps.s3.1.result.subject}}", ctx)).toBe("B");
    expect(renderTemplate("{{steps.s3.1.result}}", ctx)).toEqual({
      subject: "B",
      body: "text",
    });
  });

  it("resolves a loop's per-item results", () => {
    expect(renderTemplate("{{steps.s3.results}}", ctx)).toEqual([
      { subject: "A" },
      { subject: "B" },
    ]);
    expect(renderTemplate("{{steps.s3.results.1.subject}}", ctx)).toBe("B");
  });

  it("an unknown variable stays undefined; inputs and steps still work", () => {
    expect(renderTemplate("{{nope.x}}", ctx)).toBeUndefined();
    expect(renderTemplate("{{inputs.date}}", ctx)).toBe("2026-10-01");
    expect(renderTemplate("{{steps.s1.result.emails.1.id}}", ctx)).toBe("e2");
  });
});
