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
const messagesFile = path.resolve(packageRoot, "../..", "out", "messages.json");

async function startServer(fixtures?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/weekly.ts"],
    cwd: packageRoot,
    env: {
      ...process.env,
      ...(fixtures ? { DEMO_FIXTURES: fixtures } : {}),
    } as Record<string, string>,
  });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function textJson(result: unknown) {
  const content = (
    result as { content: Array<{ type: string; text?: string }> }
  ).content;
  return JSON.parse(content.find((c) => c.type === "text")?.text ?? "null");
}

describe("weekly-report MCP server (default fixtures)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await startServer();
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists the 7 tools; the reads are readOnly, send_message is not", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_commits",
      "get_incident_details",
      "get_incidents",
      "get_metrics",
      "get_open_issues",
      "list_repos",
      "send_message",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(t.name !== "send_message");
    }
  });

  it("list_repos returns the repos, each with an id and a name", async () => {
    const { repos } = textJson(
      await client.callTool({ name: "list_repos", arguments: {} }),
    );
    expect(repos.map((r: { name: string }) => r.name)).toEqual([
      "payments-api",
      "web-app",
      "infra-tools",
    ]);
  });

  it("get_commits and get_open_issues are per repo", async () => {
    const commits = textJson(
      await client.callTool({
        name: "get_commits",
        arguments: { repo: "web-app", date: "2026-10-04" },
      }),
    );
    expect(commits.repo).toBe("web-app");
    expect(commits.commits).toHaveLength(2);
    expect(commits.commits[0]).toHaveProperty("message");

    const issues = textJson(
      await client.callTool({
        name: "get_open_issues",
        arguments: { repo: "infra-tools", date: "2026-10-04" },
      }),
    );
    expect(issues.issues).toHaveLength(2);
  });

  it("an unknown repo is a tool error, not a crash", async () => {
    const result = await client.callTool({
      name: "get_commits",
      arguments: { repo: "nope", date: "2026-10-04" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("incidents, incident details and metrics chain together", async () => {
    const { incidents } = textJson(
      await client.callTool({
        name: "get_incidents",
        arguments: { date: "2026-10-04" },
      }),
    );
    expect(incidents[0].id).toBe("INC-101");
    const details = textJson(
      await client.callTool({
        name: "get_incident_details",
        arguments: { id: incidents[0].id },
      }),
    );
    expect(details.root_cause).toMatch(/disk/);
    const uptime = textJson(
      await client.callTool({
        name: "get_metrics",
        arguments: { metric: "uptime", date: "2026-10-04" },
      }),
    );
    expect(uptime.value).toBe(99.95);
  });

  it("send_message appends to out/messages.json", async () => {
    await rm(messagesFile, { force: true });
    await client.callTool({
      name: "send_message",
      arguments: { to: "team", text: "weekly hello" },
    });
    const written = JSON.parse(await readFile(messagesFile, "utf8"));
    expect(written.at(-1).to).toBe("team");
    await rm(messagesFile, { force: true });
  });
});

describe("weekly-report fixture sets", () => {
  it("drift renames repo `name` to `slug`", async () => {
    const client = await startServer("drift");
    try {
      const { repos } = textJson(
        await client.callTool({ name: "list_repos", arguments: {} }),
      );
      expect(repos[0]).toHaveProperty("slug");
      expect(repos[0]).not.toHaveProperty("name");
    } finally {
      await client.close();
    }
  });

  it("new-data has different repos but the same shape", async () => {
    const client = await startServer("new-data");
    try {
      const { repos } = textJson(
        await client.callTool({ name: "list_repos", arguments: {} }),
      );
      expect(repos).toHaveLength(3);
      expect(repos[0].name).toBe("billing-service");
    } finally {
      await client.close();
    }
  });
});
