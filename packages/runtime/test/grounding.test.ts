import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureTrace = path.join(
  repoRoot,
  "packages/compiler/test/fixtures/morning-brief.jsonl",
);

// Mock ONLY chat; the MCP server, guards and templates run for real.
vi.mock("hotpath-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hotpath-shared")>();
  return { ...actual, chat: vi.fn() };
});

import { chat, readTrace, type TemplateContext } from "hotpath-shared";
import { compileTrace } from "hotpath-compiler";
import { DriftError, checkGrounding, runWorkflow } from "../src/index.js";

const chatMock = vi.mocked(chat);

const ctx = (steps: TemplateContext["steps"]): TemplateContext => ({
  inputs: {},
  steps,
});

describe("checkGrounding (pure)", () => {
  const grounding = [
    { value: "Old subject", paths: ["steps.s1.result.emails.0.subject"] },
    { value: 99.95, paths: ["steps.s2.result.uptime"] },
  ];

  it("passes when the output mentions what the paths hold now", () => {
    const c = ctx({
      s1: { result: { emails: [{ subject: "New subject" }] } },
      s2: { result: { uptime: 99.99 } },
    });
    expect(checkGrounding(grounding, c, "New subject, uptime 99.99%")).toEqual(
      [],
    );
  });

  it("checks the CURRENT values, not the recorded ones", () => {
    const c = ctx({
      s1: { result: { emails: [{ subject: "New subject" }] } },
      s2: { result: { uptime: 99.99 } },
    });
    // mentions the recorded values (copied from the example) but not the new ones
    expect(checkGrounding(grounding, c, "Old subject, uptime 99.95%")).toEqual([
      "New subject",
      "99.99",
    ]);
  });

  it("skips entries whose path no longer resolves", () => {
    const c = ctx({ s1: { result: { emails: [] } }, s2: { result: {} } });
    expect(checkGrounding(grounding, c, "anything")).toEqual([]);
  });

  it("with several paths for one value, mentioning any current value is enough", () => {
    const c = ctx({
      s1: { result: { a: "alpha value", b: "beta value" } },
    });
    const g = [
      {
        value: "alpha value",
        paths: ["steps.s1.result.a", "steps.s1.result.b"],
      },
    ];
    expect(checkGrounding(g, c, "just beta value here")).toEqual([]);
    expect(checkGrounding(g, c, "neither")).toEqual(["alpha value"]);
  });

  it("is a no-op without grounding", () => {
    expect(checkGrounding(undefined, ctx({}), "x")).toEqual([]);
    expect(checkGrounding([], ctx({}), "x")).toEqual([]);
  });
});

async function fixtureWorkflow() {
  const trace = await readTrace(fixtureTrace);
  const workflow = compileTrace(trace, "fixtures/morning-brief.jsonl");
  workflow.server = [
    `"${process.execPath}"`,
    "--import",
    "tsx",
    "examples/demo-tools/src/index.ts",
  ].join(" ");
  const llm = workflow.steps.find((s) => s.type === "llm");
  if (!llm || llm.type !== "llm") throw new Error("no llm step in fixture");
  return { workflow, example: llm.example };
}

const reply = (text: string) => ({
  text,
  toolCalls: [],
  promptTokens: 10,
  completionTokens: 5,
  llmCalls: 1,
  rateLimitWaitMs: 0,
});

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  chatMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => logSpy.mockRestore());

describe("grounding guard in a run", () => {
  it("one llm call when the output mentions everything", async () => {
    const { workflow, example } = await fixtureWorkflow();
    chatMock.mockResolvedValue(reply(example));
    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(metrics.llmCalls).toBe(1);
  }, 30_000);

  it("retries once, listing what was left out, then passes", async () => {
    const { workflow, example } = await fixtureWorkflow();
    const lossy = example
      .replaceAll("Dentist appointment", "a visit")
      .replaceAll("Standup with Platform team", "a meeting");
    chatMock
      .mockResolvedValueOnce(reply(lossy))
      .mockResolvedValueOnce(reply(example));

    const metrics = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(metrics.llmCalls).toBe(2);
    const retryPrompt = chatMock.mock.calls[1][0].messages[0].content;
    expect(retryPrompt).toMatch(/left out/i);
    expect(retryPrompt).toContain("- Dentist appointment");
    expect(retryPrompt).toContain("- Standup with Platform team");
    // the first attempt's prompt is untouched
    expect(chatMock.mock.calls[0][0].messages[0].content).not.toMatch(
      /left out/i,
    );
    expect(metrics.steps.every((s) => s.ok)).toBe(true);
  }, 30_000);

  it("fails the guard (drift at the llm step) if it is still missing after the retry", async () => {
    const { workflow, example } = await fixtureWorkflow();
    const lossy = example.replaceAll("Dentist appointment", "a visit");
    chatMock.mockResolvedValue(reply(lossy));

    const error = await runWorkflow(workflow, {
      inputs: { date: "2026-10-01" },
      dryRun: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriftError);
    const drift = error as DriftError;
    expect(drift.stepId).toBe("s4");
    expect(drift.reason).toMatch(/does not mention.*Dentist appointment/);
    expect(chatMock).toHaveBeenCalledTimes(2); // original + exactly one retry
  }, 30_000);
});
