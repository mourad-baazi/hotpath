import { beforeEach, describe, expect, it, vi } from "vitest";

// Never talks to a real API: a fake client with a spy is injected.
import OpenAI from "openai";
import {
  chat,
  cheapReasoning,
  parseReasoningEffort,
  retryDelayMs,
  setClientForTesting,
} from "../src/llm.js";

const create = vi.fn();

const apiError = (status: number) =>
  new OpenAI.APIError(status, { message: "bad" }, "bad", {});

const rateLimit = (headers: Record<string, string>) =>
  new OpenAI.APIError(429, { message: "slow down" }, "slow down", headers);

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
    create.mockRejectedValueOnce(apiError(401));
    await expect(
      chat({ model: "m", messages, reasoningEffort: "low" }),
    ).rejects.toThrow(/401/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("retryDelayMs", () => {
  it("prefers retry-after-ms, then retry-after seconds, then backoff", () => {
    expect(retryDelayMs({ "retry-after-ms": "180" }, 0)).toBe(180);
    expect(retryDelayMs({ "retry-after": "2" }, 0)).toBe(2000);
    expect(retryDelayMs({}, 0)).toBe(500);
    expect(retryDelayMs({}, 2)).toBe(2000);
    expect(retryDelayMs(undefined, 10)).toBe(8000); // capped
  });
});

describe("rate-limit retries are counted, not hidden", () => {
  const messages = [{ role: "user" as const, content: "x" }];

  it("waits out a 429, retries, and reports the time spent waiting", async () => {
    create
      .mockRejectedValueOnce(rateLimit({ "retry-after-ms": "40" }))
      .mockRejectedValueOnce(rateLimit({ "retry-after-ms": "30" }));
    const result = await chat({ model: "m", messages });
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("hi");
    expect(result.rateLimitWaitMs).toBeGreaterThanOrEqual(70);
    expect(result.rateLimitWaitMs).toBeLessThan(400);
  });

  it("reports 0 when nothing was rate limited", async () => {
    const result = await chat({ model: "m", messages });
    expect(result.rateLimitWaitMs).toBe(0);
  });

  it("gives up after the retry limit and throws the 429", async () => {
    create.mockRejectedValue(rateLimit({ "retry-after-ms": "1" }));
    await expect(chat({ model: "m", messages })).rejects.toThrow(/429/);
    expect(create).toHaveBeenCalledTimes(7); // 1 try + 6 retries
  });

  it("does not wait minutes for a daily quota: a long retry-after fails fast", async () => {
    create.mockRejectedValue(rateLimit({ "retry-after": "225" }));
    const started = Date.now();
    await expect(chat({ model: "m", messages })).rejects.toThrow(/429/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
