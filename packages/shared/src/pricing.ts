import { AGENT_MODEL } from "./llm.js";

// Token prices in USD per 1M tokens (PRICE_* env vars, see .env.example).
export interface TokenPrices {
  inputPer1M: number;
  outputPer1M: number;
}

export function pricesFor(model: string): TokenPrices {
  const isAgent = model === AGENT_MODEL;
  return {
    inputPer1M: numberEnv(
      isAgent ? "PRICE_AGENT_IN" : "PRICE_CHEAP_IN",
      isAgent ? 3 : 0.95,
    ),
    outputPer1M: numberEnv(
      isAgent ? "PRICE_AGENT_OUT" : "PRICE_CHEAP_OUT",
      isAgent ? 15 : 4,
    ),
  };
}

export function usdCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const { inputPer1M, outputPer1M } = pricesFor(model);
  return (
    (promptTokens * inputPer1M + completionTokens * outputPer1M) / 1_000_000
  );
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
