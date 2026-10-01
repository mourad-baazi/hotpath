import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const messagesFile = path.join(repoRoot, "out", "messages.json");

async function startServer(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: packageRoot,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function textJson(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return JSON.parse(text ?? "null");
}

describe("demo-tools MCP server", () => {
  let client: Client;

  beforeAll(async () => {
    client = await startServer();
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists 4 tools with the right names and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_calendar",
      "get_emails",
      "get_weather",
      "send_message",
    ]);
    for (const name of ["get_emails", "get_calendar", "get_weather"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const send = tools.find((t) => t.name === "send_message")!;
    expect(send.annotations?.readOnlyHint).toBe(false);
    expect(send.annotations?.destructiveHint).toBe(false);
  });

  it("get_emails returns the default fixture data", async () => {
    const result = await client.callTool({
      name: "get_emails",
      arguments: { date: "2026-10-01" },
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(packageRoot, "fixtures/default/emails.json"),
        "utf8",
      ),
    );
    expect(textJson(result)).toEqual(fixture);
  });

  it("get_calendar returns the default fixture data", async () => {
    const result = await client.callTool({
      name: "get_calendar",
      arguments: { date: "2026-10-01" },
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(packageRoot, "fixtures/default/calendar.json"),
        "utf8",
      ),
    );
    expect(textJson(result)).toEqual(fixture);
  });

  it("get_weather returns the default fixture data", async () => {
    const result = await client.callTool({
      name: "get_weather",
      arguments: { city: "Paris", date: "2026-10-01" },
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(packageRoot, "fixtures/default/weather.json"),
        "utf8",
      ),
    );
    expect(textJson(result)).toEqual(fixture);
  });

  it("send_message appends to out/messages.json", async () => {
    await rm(messagesFile, { force: true });
    const result = await client.callTool({
      name: "send_message",
      arguments: { to: "me", text: "hello from the test" },
    });
    expect(textJson(result)).toEqual({ ok: true, id: "m1" });
    const written = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(written).toHaveLength(1);
    expect(written[0].to).toBe("me");
    expect(written[0].text).toBe("hello from the test");
    expect(typeof written[0].at).toBe("string");
  });
});

describe("DEMO_FIXTURES=new-data", () => {
  let client: Client;

  beforeAll(async () => {
    client = await startServer({ DEMO_FIXTURES: "new-data" });
  });

  afterAll(async () => {
    await client.close();
  });

  it("returns the new-data fixture emails", async () => {
    const result = await client.callTool({
      name: "get_emails",
      arguments: { date: "2026-10-02" },
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(packageRoot, "fixtures/new-data/emails.json"),
        "utf8",
      ),
    );
    expect(textJson(result)).toEqual(fixture);
    const subjects = fixture.emails.map((e: { subject: string }) => e.subject);
    expect(subjects).not.toContain("Q3 budget review moved to 14:00");
  });
});
