import { describe, expect, it } from "vitest";

import type { Workflow } from "hotpath-shared";

import { allSteps, summarize, workflowToGraph } from "../src/graph.js";

const workflow: Workflow = {
  version: 1,
  task: "inbox-digest",
  compiledFrom: "test",
  server: "inbox",
  inputs: {},
  steps: [
    {
      id: "s1",
      type: "tool",
      tool: "get_inbox",
      args: {},
      sideEffect: false,
      guard: {},
    },
    {
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
          args: { id: "{{email.id}}" },
          sideEffect: false,
          guard: {},
        },
      ],
    },
    {
      id: "s3",
      type: "llm",
      model: "cheap",
      prompt: "{{steps.s2.results}}",
      example: "x",
      guard: {},
    },
  ],
};

describe("loops in the viewer graph", () => {
  it("draws a loop as a group node containing its body", () => {
    const { nodes } = workflowToGraph(workflow);
    expect(nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      "s1:step",
      "s2:loop",
      "s2.1:step",
      "s3:step",
    ]);
    const loop = nodes.find((n) => n.id === "s2")!;
    const body = nodes.find((n) => n.id === "s2.1")!;
    expect(loop.data.label).toBe("for each email");
    expect(body.parentId).toBe("s2");
    expect(body.extent).toBe("parent");
    // the body fits inside the group
    expect(body.position.y + 90).toBeLessThanOrEqual(loop.style!.height);
  });

  it("connects the loop to the list it reads and to the steps reading its results", () => {
    const pairs = workflowToGraph(workflow).edges.map(
      (e) => `${e.source}->${e.target}`,
    );
    expect(pairs.sort()).toEqual(["s1->s2", "s2->s3"]);
  });

  it("puts the row after a loop below the whole group", () => {
    const { nodes } = workflowToGraph(workflow);
    const loop = nodes.find((n) => n.id === "s2")!;
    const after = nodes.find((n) => n.id === "s3")!;
    expect(after.position.y).toBeGreaterThan(
      loop.position.y + loop.style!.height,
    );
  });

  it("summary counts loops; selection finds body steps", () => {
    expect(summarize(workflow)).toBe("3 steps · 1 use AI · 1 loop");
    expect(allSteps(workflow).map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s2.1",
      "s3",
    ]);
  });
});
