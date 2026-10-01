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

const MAX_TURNS = 12;

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
}

function systemPrompt(date: string): string {
  return (
    `You are a personal assistant. Today is ${date}. Produce the user's morning brief: ` +
    `read today's emails, calendar and the weather in Paris, then call send_message ` +
    `with to="me" and a concise brief that mentions every email subject, every event ` +
    `and the weather.`
  );
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
      { role: "system", content: systemPrompt(options.date) },
      { role: "user", content: "Please produce the morning brief now." },
    ];

    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await chat({ model: AGENT_MODEL, messages, tools });
      llmCalls += result.llmCalls;
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;

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
    `agent run: ${metrics.llmCalls} llm calls, ${metrics.durationMs}ms, $${metrics.costUsd.toFixed(4)}`,
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
