import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let client: Client;

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

beforeAll(async () => {
  client = new Client({ name: "test", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/inbox.ts"],
      env: { ...process.env, DEMO_FIXTURES: "default" } as Record<
        string,
        string
      >,
    }),
  );
});
afterAll(async () => {
  await client.close();
});

describe("inbox MCP server", () => {
  it("lists get_inbox, get_email (read-only) and send_message", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_email",
      "get_inbox",
      "send_message",
    ]);
    expect(
      tools.find((t) => t.name === "get_email")!.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("get_inbox returns summaries without bodies; get_email returns one email", async () => {
    const inbox = parse(
      await client.callTool({
        name: "get_inbox",
        arguments: { date: "2026-10-01" },
      }),
    );
    expect(inbox.emails.map((e: { id: string }) => e.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(inbox.emails[0]).not.toHaveProperty("body");
    const email = parse(
      await client.callTool({ name: "get_email", arguments: { id: "e2" } }),
    );
    expect(email).toMatchObject({
      id: "e2",
      subject: "Team offsite: draft agenda attached",
    });
    expect(email.body.length).toBeGreaterThan(10);
  });

  it("an unknown id is a tool error", async () => {
    const r = await client.callTool({
      name: "get_email",
      arguments: { id: "nope" },
    });
    expect(r.isError).toBe(true);
  });
});
