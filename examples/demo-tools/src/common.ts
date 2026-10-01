import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { appendMessage } from "./messages.js";

/** A tool result carrying JSON text (the shape every demo tool returns). */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** A tool-level error (isError) instead of a protocol error. */
export function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// Shared by every demo server: the one tool with a side effect (writes a file).
export function registerSendMessage(server: McpServer): void {
  server.registerTool(
    "send_message",
    {
      description: "Send a message (writes to out/messages.json)",
      inputSchema: {
        to: z.string().describe("Recipient"),
        text: z.string().describe("Message text"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ to, text }) => {
      const message = await appendMessage({ to, text });
      return jsonResult({ ok: true, id: message.id });
    },
  );
}
