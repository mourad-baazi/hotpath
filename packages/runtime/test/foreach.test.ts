import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// never hit a real API (these workflows have no llm step anyway)
vi.mock("hotpath-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hotpath-shared")>();
  return { ...actual, chat: vi.fn() };
});

import type { ToolStep, Workflow } from "hotpath-shared";
import { DriftError, runWorkflow } from "../src/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const messagesFile = path.join(repoRoot, "out", "messages.json");

const bodyGuard = {
  schema: {
    type: "object",
    properties: { id: { type: "string" }, subject: { type: "string" } },
    required: ["id", "subject"],
  },
};

function inboxWorkflow(
  body: ToolStep,
  extra: Partial<Workflow> = {},
  maxItems = 50,
): Workflow {
  return {
    version: 1,
    task: "foreach-test",
    compiledFrom: "test",
    server: "inbox",
    serverArgv: [
      process.execPath,
      "--import",
      "tsx",
      path.join(repoRoot, "examples/demo-tools/src/inbox.ts"),
    ],
    cwd: repoRoot,
    inputs: {},
    steps: [
      {
        id: "s1",
        type: "tool",
        tool: "get_inbox",
        args: { date: "2026-10-01" },
        sideEffect: false,
        guard: {},
      },
      {
        id: "s2",
        type: "foreach",
        over: "{{steps.s1.result.emails}}",
        as: "email",
        body: [body],
        maxItems,
      },
    ],
    ...extra,
  };
}

const getEmail: ToolStep = {
  id: "s2.1",
  type: "tool",
  tool: "get_email",
  args: { id: "{{email.id}}" },
  sideEffect: false,
  guard: bodyGuard,
};

async function withFixtures<T>(set: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.DEMO_FIXTURES;
  process.env.DEMO_FIXTURES = set;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DEMO_FIXTURES;
    else process.env.DEMO_FIXTURES = before;
  }
}

afterEach(async () => {
  await rm(messagesFile, { force: true });
});

describe("foreach at run time", () => {
  it("runs the body once per item, in order", async () => {
    const metrics = await withFixtures("default", () =>
      runWorkflow(inboxWorkflow(getEmail), { inputs: {} }),
    );
    expect(metrics.toolCalls).toEqual([
      { tool: "get_inbox", args: { date: "2026-10-01" } },
      { tool: "get_email", args: { id: "e1" } },
      { tool: "get_email", args: { id: "e2" } },
      { tool: "get_email", args: { id: "e3" } },
    ]);
    expect(metrics.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
  }, 30_000);

  it("handles a list with more items than when it was recorded (new data)", async () => {
    const metrics = await withFixtures("new-data", () =>
      runWorkflow(inboxWorkflow(getEmail), { inputs: {} }),
    );
    expect(
      metrics.toolCalls.filter((c) => c.tool === "get_email"),
    ).toHaveLength(4);
  }, 30_000);

  it("an empty list is zero iterations, not an error", async () => {
    const metrics = await withFixtures("empty-inbox", () =>
      runWorkflow(inboxWorkflow(getEmail), { inputs: {} }),
    );
    expect(metrics.toolCalls.map((c) => c.tool)).toEqual(["get_inbox"]);
  }, 30_000);

  it("one item is one iteration", async () => {
    const metrics = await withFixtures("one-email", () =>
      runWorkflow(inboxWorkflow(getEmail), { inputs: {} }),
    );
    expect(metrics.toolCalls.map((c) => c.tool)).toEqual([
      "get_inbox",
      "get_email",
    ]);
  }, 30_000);

  it("stops at maxItems with a warning", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = await withFixtures("default", () =>
      runWorkflow(inboxWorkflow(getEmail, {}, 2), { inputs: {} }),
    );
    expect(
      metrics.toolCalls.filter((c) => c.tool === "get_email"),
    ).toHaveLength(2);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "running the first 2 (maxItems)",
    );
    log.mockRestore();
  }, 30_000);

  it("a guard failing in any iteration is drift for the run", async () => {
    const err = await withFixtures("drift", () =>
      runWorkflow(inboxWorkflow(getEmail), { inputs: {} }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(DriftError);
    expect(err.stepId).toBe("s2");
    expect(err.reason).toContain("s2.1 (item 1 of 3)");
    expect(err.sideEffectRan).toBe(false);
  }, 30_000);

  it("drift after a side effect ran in an earlier iteration is flagged, so no fallback", async () => {
    // body sends a message per email, then its guard fails on the result
    const send: ToolStep = {
      id: "s2.1",
      type: "tool",
      tool: "send_message",
      args: { to: "me", text: "about {{email.subject}}" },
      sideEffect: true,
      guard: {
        schema: {
          type: "object",
          properties: { nope: {} },
          required: ["nope"],
        },
      },
    };
    const err = await withFixtures("default", () =>
      runWorkflow(inboxWorkflow(send), { inputs: {} }).catch((e) => e),
    );
    expect(err).toBeInstanceOf(DriftError);
    expect(err.sideEffectRan).toBe(true);
    const sent = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(sent).toHaveLength(1); // stopped at the first iteration
  }, 30_000);

  it("--dry-run skips side effects inside the loop", async () => {
    const send: ToolStep = {
      id: "s2.1",
      type: "tool",
      tool: "send_message",
      args: { to: "me", text: "about {{email.subject}}" },
      sideEffect: true,
      guard: {},
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = await withFixtures("default", () =>
      runWorkflow(inboxWorkflow(send), { inputs: {}, dryRun: true }),
    );
    expect(metrics.toolCalls.map((c) => c.tool)).toEqual(["get_inbox"]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      'dry-run: s2.1 (item 2 of 3) send_message would send {"to":"me","text":"about Team offsite: draft agenda attached"}',
    );
    log.mockRestore();
  }, 30_000);

  it("after the loop, {{steps.<loop>.results}} holds the per-item results", async () => {
    const send: ToolStep = {
      id: "s3",
      type: "tool",
      tool: "send_message",
      args: {
        to: "me",
        text: "first: {{steps.s2.results.0.subject}}, count via list",
      },
      sideEffect: true,
      guard: {},
    };
    const wf = inboxWorkflow(getEmail);
    wf.steps.push(send);
    const metrics = await withFixtures("default", () =>
      runWorkflow(wf, { inputs: {} }),
    );
    expect(metrics.toolCalls.at(-1)).toEqual({
      tool: "send_message",
      args: {
        to: "me",
        text: "first: Q3 budget review moved to 14:00, count via list",
      },
    });
  }, 30_000);
});
