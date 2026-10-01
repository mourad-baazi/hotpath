import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { errorResult, jsonResult, registerSendMessage } from "./common.js";
import { loadFixture } from "./fixtures.js";

// Fake inbox: list today's emails, then open each one. The agent makes one
// get_email call per email, which Hotpath compiles into a foreach loop.
const server = new McpServer({ name: "demo-tools-inbox", version: "0.1.0" });

type Email = { id: string; from: string; body: string } & Record<
  string,
  unknown
>;

const loadEmails = async () =>
  (await loadFixture<{ emails: Email[] }>("inbox")).emails;

server.registerTool(
  "get_inbox",
  {
    description: "List today's emails (id, sender and subject only)",
    inputSchema: { date: z.string().describe("ISO date, e.g. 2026-10-01") },
    annotations: { readOnlyHint: true },
  },
  async () =>
    jsonResult({
      emails: (await loadEmails()).map((email) => {
        const summary: Record<string, unknown> = { ...email };
        delete summary.body;
        return summary;
      }),
    }),
);

server.registerTool(
  "get_email",
  {
    description: "Open one email by id (full body)",
    inputSchema: { id: z.string().describe("Email id from get_inbox") },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => {
    const email = (await loadEmails()).find((e) => e.id === id);
    return email ? jsonResult(email) : errorResult(`unknown email id: ${id}`);
  },
);

registerSendMessage(server);

const transport = new StdioServerTransport();
await server.connect(transport);
