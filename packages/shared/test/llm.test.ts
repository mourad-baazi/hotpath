import { beforeEach, describe, expect, it, vi } from "vitest";

// Never talks to a real API: a fake client with a spy is injected.
import OpenAI from "openai";
import {
  chat,
  cheapReasoning,
  parseReasoningEffort,
  setClientForTesting,
} from "../src/llm.js";

const create = vi.fn();

const apiError = (status: number) =>
  new OpenAI.APIError(status, { message: "bad" }, "bad", {});

const reply = {
  choices: [{ message: { content: "hi", tool_calls: [] } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

beforeEach(() => {
  setClientForTesting({
    chat: { completions: { create } },
  } as unknown as OpenAI);
  create.mockReset();
  create.mockResolvedValue(reply);
});

describe("parseReasoningEffort", () => {
  it("accepts low/medium/high and treats empty as unset", () => {
    expect(parseReasoningEffort(undefined)).toBeUndefined();
    expect(parseReasoningEffort("")).toBeUndefined();
    expect(parseReasoningEffort("low")).toBe("low");
    expect(parseReasoningEffort("HIGH")).toBe("high");
  });

  it("rejects anything else with a message saying what to do", () => {
    expect(() => parseReasoningEffort("fast")).toThrow(
      /HOTPATH_CHEAP_REASONING.*low, medium or high/,
    );
  });
});

describe("cheapReasoning", () => {
  it("reads HOTPATH_CHEAP_REASONING at call time", () => {
    process.env.HOTPATH_CHEAP_REASONING = "low";
    expect(cheapReasoning()).toBe("low");
    delete process.env.HOTPATH_CHEAP_REASONING;
    expect(cheapReasoning()).toBeUndefined();
  });
});

describe("chat reasoningEffort", () => {
  const messages = [{ role: "user" as const, content: "x" }];

  it("passes reasoning_effort when asked", async () => {
    await chat({ model: "m", messages, reasoningEffort: "low" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].reasoning_effort).toBe("low");
  });

  it("omits it by default", async () => {
    await chat({ model: "m", messages });
    expect("reasoning_effort" in create.mock.calls[0][0]).toBe(false);
  });

  it("retries once without it when the provider rejects the parameter", async () => {
    create.mockRejectedValueOnce(apiError(400));
    const result = await chat({ model: "m", messages, reasoningEffort: "low" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].reasoning_effort).toBe("low");
    expect("reasoning_effort" in create.mock.calls[1][0]).toBe(false);
    expect(result.text).toBe("hi");
  });

  it("does not swallow other errors", async () => {
    create.mockRejectedValueOnce(apiError(500));
    await expect(
      chat({ model: "m", messages, reasoningEffort: "low" }),
    ).rejects.toThrow(/500/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
