import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { TraceWriter } from "./trace-writer.js";

export interface RecorderOptions {
  task: string;
  /** server command + args, e.g. ["pnpm", "--silent", "--filter", "demo-tools", "start"] */
  serverArgv: string[];
}

// MCP proxy: MCP server on stdio towards the agent, MCP client towards the
// spawned real server. Forwards tools/list and tools/call unchanged and
// records them into a trace. Resolves when the agent disconnects (stdin
// close) or on SIGTERM.
export async function runRecorder(
  options: RecorderOptions,
): Promise<{ traceFile: string }> {
  const [command, ...args] = options.serverArgv;
  if (!command) {
    throw new Error("usage: hotpath record --task <name> -- <server command…>");
  }

  const serverCommand = options.serverArgv.join(" ");
  const writer = new TraceWriter(options.task);
  console.error(
    `[recorder] task=${options.task} trace=${writer.file} server=${serverCommand}`,
  );

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env } as Record<string, string>,
    // no shell: the MCP SDK starts the server with cross-spawn, which also
    // handles .cmd shims (pnpm, npx) on Windows
  });
  const upstream = new Client({ name: "hotpath-recorder", version: "0.1.0" });
  await upstream.connect(transport);

  let metaWritten = false;
  let pending = 0;
  let finalizeRequested = false;
  let doFinalize: () => Promise<void> = async () => {};

  // Run `fn` as a recorded operation; a requested shutdown waits for all
  // in-flight operations so the trace keeps its meta…calls…end ordering.
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    pending++;
    try {
      return await fn();
    } finally {
      pending--;
      if (finalizeRequested && pending === 0) await doFinalize();
    }
  }

  async function maybeWriteMeta(): Promise<void> {
    if (metaWritten) return;
    metaWritten = true;
    let inputs: Record<string, unknown> = {};
    try {
      inputs = JSON.parse(process.env.HOTPATH_INPUTS ?? "{}");
    } catch {
      console.error("[recorder] HOTPATH_INPUTS is not valid JSON, ignoring");
    }
    const { tools } = await upstream.listTools();
    writer.writeMeta({
      version: 1,
      task: options.task,
      startedAt: new Date().toISOString(),
      server: serverCommand,
      inputs,
      tools: tools.map((t) => ({
        name: t.name,
        inputSchema: t.inputSchema as Record<string, unknown>,
        annotations: t.annotations,
      })),
    });
  }

  const server = new Server(
    { name: "hotpath-recorder", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    tracked(async () => {
      await maybeWriteMeta();
      return await upstream.listTools();
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    tracked(async () => {
      await maybeWriteMeta();
      const seq = writer.nextSeq();
      const startedAt = new Date().toISOString();
      const start = Date.now();
      const result = (await upstream.callTool(
        request.params,
      )) as CallToolResult;
      writer.write({
        type: "tool_call",
        seq,
        tool: request.params.name,
        args: (request.params.arguments ?? {}) as Record<string, unknown>,
        result: extractResult(result),
        isError: result.isError === true,
        startedAt,
        durationMs: Date.now() - start,
      });
      return result;
    }),
  );

  const done = new Promise<void>((resolve) => {
    let finalized = false;
    doFinalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      await writer.writeEnd(new Date().toISOString());
      console.error(`[recorder] trace closed: ${writer.file}`);
      await upstream.close().catch(() => {});
      resolve();
    };
    const requestFinalize = (): void => {
      finalizeRequested = true;
      // Request handlers start asynchronously (schema validation), so a
      // request in flight at disconnect may not have registered yet — poll
      // briefly instead of checking once.
      const timer = setInterval(() => {
        if (pending === 0) {
          clearInterval(timer);
          void doFinalize();
        }
      }, 25);
      timer.unref?.();
    };
    server.onclose = requestFinalize;
    // StdioServerTransport doesn't watch stdin EOF — detect agent disconnect
    // ourselves and finalize the trace.
    process.stdin.on("end", requestFinalize);
    process.on("SIGTERM", requestFinalize);
    process.on("SIGINT", requestFinalize);
  });

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  await done;
  return { traceFile: writer.file };
}

// SPEC §5.1: structured content if present, else parsed JSON of the first
// text content, else the raw text.
function extractResult(result: CallToolResult): unknown {
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (sc !== undefined) return sc;
  const text = result.content?.find((c) => c.type === "text");
  if (text && "text" in text && typeof text.text === "string") {
    try {
      return JSON.parse(text.text);
    } catch {
      return text.text;
    }
  }
  return result.content ?? null;
}
