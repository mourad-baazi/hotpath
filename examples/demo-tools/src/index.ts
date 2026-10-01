import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { appendMessage } from "./messages.js";
import { loadFixture } from "./fixtures.js";

const server = new McpServer({ name: "demo-tools", version: "0.1.0" });

const dateArg = { date: z.string().describe("ISO date, e.g. 2026-10-01") };

server.registerTool(
  "get_emails",
  {
    description: "Get the emails for a date",
    inputSchema: dateArg,
    annotations: { readOnlyHint: true },
  },
  async ({ date }) => {
    const { emails } = await loadFixture<{ emails: Array<{ date?: string }> }>(
      "emails",
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ emails: emailsForDate(emails, date) }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_calendar",
  {
    description: "Get the calendar events for a date",
    inputSchema: dateArg,
    annotations: { readOnlyHint: true },
  },
  async ({ date }) => {
    const { events } = await loadFixture<{ events: Array<{ date?: string }> }>(
      "calendar",
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ events: eventsForDate(events, date) }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_weather",
  {
    description: "Get the weather for a city on a date",
    inputSchema: {
      city: z.string().describe("City name, e.g. Paris"),
      date: z.string().describe("ISO date, e.g. 2026-10-01"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ city, date }) => {
    const weather = await loadFixture<Record<string, unknown>>("weather");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...weather, city, date }),
        },
      ],
    };
  },
);

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
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, id: message.id }) },
      ],
    };
  },
);

function emailsForDate(emails: Array<{ date?: string }>, date: string) {
  return emails.filter((e) => e.date === undefined || e.date === date);
}

function eventsForDate(events: Array<{ date?: string }>, date: string) {
  return events.filter((e) => e.date === undefined || e.date === date);
}

const transport = new StdioServerTransport();
await server.connect(transport);
