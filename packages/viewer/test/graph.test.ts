import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compileTrace } from "hotpath-compiler";
import { readTrace } from "hotpath-shared";

import { summarize, workflowToGraph } from "../src/graph.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../compiler/test/fixtures/morning-brief.jsonl",
);

async function morningBrief() {
  return compileTrace(await readTrace(fixture), "fixtures/morning-brief.jsonl");
}

describe("workflowToGraph", () => {
  it("makes one node per step with the right kind and side-effect mark", async () => {
    const { nodes } = workflowToGraph(await morningBrief());
    expect(nodes.map((n) => n.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(nodes.map((n) => n.data.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "llm",
      "tool",
    ]);
    expect(nodes.filter((n) => n.data.sideEffect).map((n) => n.id)).toEqual([
      "s5",
    ]);
    expect(nodes[0].data.label).toBe("get_emails");
    expect(nodes[3].data.label).toMatch(/llm/i);
  });

  it("draws edges from template references (s1,s2,s3 → s4 → s5)", async () => {
    const { edges } = workflowToGraph(await morningBrief());
    const pairs = edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs).toEqual(["s1->s4", "s2->s4", "s3->s4", "s4->s5"]);
  });

  it("lays nodes out by dependency depth", async () => {
    const { nodes } = workflowToGraph(await morningBrief());
    const y = Object.fromEntries(nodes.map((n) => [n.id, n.position.y]));
    expect(y.s1).toBe(y.s2);
    expect(y.s2).toBe(y.s3);
    expect(y.s4).toBeGreaterThan(y.s3);
    expect(y.s5).toBeGreaterThan(y.s4);
    const x = nodes.slice(0, 3).map((n) => n.position.x);
    expect(new Set(x).size).toBe(3);
  });

  it("does not add an edge for {{inputs.*}} references", async () => {
    const { edges } = workflowToGraph(await morningBrief());
    expect(edges.every((e) => e.source.startsWith("s"))).toBe(true);
  });

  it("summarizes as 'N steps · M use AI'", async () => {
    expect(summarize(await morningBrief())).toBe("5 steps · 1 use AI");
  });
});
