import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

// Load .env from the repo root regardless of the caller's cwd (agents and
// bench run from package dirs via pnpm --filter).
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
];
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

export const AGENT_MODEL = process.env.HOTPATH_AGENT_MODEL ?? "kimi-k3";
export const CHEAP_MODEL = process.env.HOTPATH_CHEAP_MODEL ?? "kimi-k2.7-code";

// LLM_API_KEY/LLM_BASE_URL (NVIDIA Cloud etc.); MOONSHOT_* kept as fallback.
const BASE_URL =
  process.env.LLM_BASE_URL ??
  process.env.MOONSHOT_BASE_URL ??
  "https://api.moonshot.ai/v1";

let client: OpenAI | null = null;

/** Test seam: inject a fake client (or null to reset). */
export function setClientForTesting(fake: OpenAI | null): void {
  client = fake;
}

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.LLM_API_KEY ?? process.env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LLM_API_KEY is not set — copy .env.example to .env and fill it in",
      );
    }
    // more retries than the SDK default (2): free-tier per-minute limits are tight
    client = new OpenAI({ apiKey, baseURL: BASE_URL, maxRetries: 6 });
  }
  return client;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string | null;
  toolCalls: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
}

export type ReasoningEffort = "low" | "medium" | "high";

/** HOTPATH_CHEAP_REASONING: unset/empty = provider default. */
export function parseReasoningEffort(
  raw: string | undefined,
): ReasoningEffort | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(
    `HOTPATH_CHEAP_REASONING="${raw}" is not valid — use low, medium or high (or leave it unset)`,
  );
}

/** Reasoning effort for the cheap model (workflow llm steps), read from the env on use. */
export function cheapReasoning(): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env.HOTPATH_CHEAP_REASONING);
}

// The ONLY place in the repo that talks to an LLM API.
export async function chat(options: {
  model: string;
  messages: ChatMessage[];
  tools?: LlmToolSpec[];
  /** sent as reasoning_effort; dropped (once) if the provider rejects it */
  reasoningEffort?: ReasoningEffort;
}): Promise<LlmResult> {
  const request = {
    model: options.model,
    messages: options.messages.map(toOpenAiMessage),
    tools: options.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice:
      options.tools && options.tools.length > 0 ? ("auto" as const) : undefined,
  };
  const completions = getClient().chat.completions;
  let response;
  if (options.reasoningEffort === undefined) {
    response = await completions.create(request);
  } else {
    try {
      response = await completions.create({
        ...request,
        reasoning_effort: options.reasoningEffort,
      });
    } catch (err) {
      // Not every provider/model knows reasoning_effort: retry without it.
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      if (status !== 400 && status !== 422) throw err;
      response = await completions.create(request);
    }
  }

  const choice = response.choices[0];
  const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map(
    (tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJson(tc.function.arguments),
    }),
  );

  return {
    text: choice.message.content,
    toolCalls,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    llmCalls: 1,
  };
}

function toOpenAiMessage(
  m: ChatMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
