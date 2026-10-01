import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_MODEL,
  chat,
  usdCost,
  type ChatMessage,
  type LlmToolSpec,
} from "hotpath-shared";

import { loadTaskConfig, repoRoot, splitCommand } from "./config.js";

export interface AgentOptions {
  task: string;
  date: string;
}

export interface AgentMetrics {
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** time spent waiting on rate-limit retries (included in durationMs) */
  rateLimitWaitMs: number;
}

const PROMPTS: Record<
  string,
  { system: (date: string) => string; user: string; maxTurns: number }
> = {
  "morning-brief": {
    system: (date) =>
      `You are a personal assistant. Today is ${date}. Produce the user's morning brief: ` +
      `read today's emails, calendar and the weather in Paris, then call send_message ` +
      `with to="me" and a concise brief that mentions every email subject, every event ` +
      `and the weather.`,
    user: "Please produce the morning brief now.",
    maxTurns: 12,
  },
  "weekly-report": {
    system: (date) =>
      `You are an engineering manager's assistant. The week ends on ${date}. Produce the ` +
      `weekly report: list the repositories; for each repository read its commits and its ` +
      `open issues; read the week's incidents and the details of each incident; read the ` +
      `deploys and uptime metrics. Make independent calls together in the same step. Then ` +
      `call send_message twice: once with to="team" and a summary that mentions every ` +
      `repository with its main changes and open issues, and once with to="manager" and a ` +
      `short executive summary that mentions each incident (id and title), the deploys ` +
      `count and the uptime. You must call send_message exactly twice (team, then manager) ` +
      `and only finish after both messages are sent.`,
    user: "Please produce the weekly report now and send both messages.",
    // models often make one tool call per turn, and this task needs 13
    maxTurns: 20,
  },
};

function promptFor(task: string) {
  const entry = PROMPTS[task];
  if (!entry) {
    throw new Error(
      `no prompt for task "${task}" — demo-agent knows: ${Object.keys(PROMPTS).join(", ")}`,
    );
  }
  return entry;
}

export function systemPrompt(task: string, date: string): string {
  return promptFor(task).system(date);
}

export function maxTurns(task: string): number {
  return promptFor(task).maxTurns;
}

export function userRequest(task: string): string {
  return promptFor(task).user;
}

export async function runAgent(options: AgentOptions): Promise<AgentMetrics> {
  const start = Date.now();
  const { server } = await loadTaskConfig(options.task);

  // Connect to MCP *through* the recorder proxy so the run is traced:
  // `hotpath record --task <task> -- <server command from hotpath.config.json>`
  const serverArgv = splitCommand(server);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.join(repoRoot, "packages/cli/src/index.ts"),
      "record",
      "--task",
      options.task,
      "--",
      ...serverArgv,
    ],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOTPATH_INPUTS: JSON.stringify({ date: options.date }),
    },
  });
  const client = new Client({ name: "demo-agent", version: "0.1.0" });
  await client.connect(transport);

  let metrics: AgentMetrics;
  try {
    const { tools: mcpTools } = await client.listTools();
    const tools: LlmToolSpec[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    }));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(options.task, options.date) },
      { role: "user", content: userRequest(options.task) },
    ];

    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let rateLimitWaitMs = 0;

    for (let turn = 0; turn < maxTurns(options.task); turn++) {
      const result = await chat({ model: AGENT_MODEL, messages, tools });
      llmCalls += result.llmCalls;
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      rateLimitWaitMs += result.rateLimitWaitMs ?? 0;

      if (process.env.HOTPATH_DEBUG) {
        console.error(
          `[agent turn ${turn + 1}] tools: ${result.toolCalls.map((c) => c.name).join(", ") || "-"}` +
            (result.text ? ` | text: ${result.text.slice(0, 200)}` : ""),
        );
      }

      if (result.toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        const toolResult = await client.callTool({
          name: call.name,
          arguments: call.arguments,
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: extractText(toolResult),
        });
      }
    }

    metrics = {
      durationMs: Date.now() - start,
      llmCalls,
      promptTokens,
      completionTokens,
      costUsd: usdCost(AGENT_MODEL, promptTokens, completionTokens),
      rateLimitWaitMs,
    };
  } finally {
    await client.close();
  }

  const outDir = path.join(repoRoot, "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "agent-run.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    `agent run: ${metrics.llmCalls} llm calls, ${metrics.durationMs}ms, $${metrics.costUsd.toFixed(4)}` +
      (metrics.rateLimitWaitMs > 0
        ? ` (incl. ${metrics.rateLimitWaitMs}ms rate-limit wait)`
        : ""),
  );
  return metrics;
}

function extractText(result: unknown): string {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text !== undefined) return text;
  return JSON.stringify(result);
}
