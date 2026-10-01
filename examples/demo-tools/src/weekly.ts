import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { errorResult, jsonResult, registerSendMessage } from "./common.js";
import { loadFixture } from "./fixtures.js";

// Fake "weekly engineering report" tools: several reads (some of whose results
// feed the next call's arguments) and the same send_message side effect.
const server = new McpServer({ name: "demo-tools-weekly", version: "0.1.0" });

const readOnly = { readOnlyHint: true };
const date = z.string().describe("Week-ending date, ISO, e.g. 2026-10-04");
const repo = z.string().describe("Repository name, e.g. payments-api");

server.registerTool(
  "list_repos",
  {
    description: "List the team's repositories",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => jsonResult(await loadFixture("repos")),
);

server.registerTool(
  "get_commits",
  {
    description: "Get the week's commits for a repository",
    inputSchema: { repo, date },
    annotations: readOnly,
  },
  async ({ repo }) => {
    const all = await loadFixture<Record<string, unknown>>("commits");
    if (!(repo in all)) return errorResult(`unknown repository: ${repo}`);
    return jsonResult({ repo, commits: all[repo] });
  },
);

server.registerTool(
  "get_open_issues",
  {
    description: "Get a repository's open issues",
    inputSchema: { repo, date },
    annotations: readOnly,
  },
  async ({ repo }) => {
    const all = await loadFixture<Record<string, unknown>>("issues");
    if (!(repo in all)) return errorResult(`unknown repository: ${repo}`);
    return jsonResult({ repo, issues: all[repo] });
  },
);

server.registerTool(
  "get_incidents",
  {
    description: "List the production incidents of the week",
    inputSchema: { date },
    annotations: readOnly,
  },
  async () => jsonResult(await loadFixture("incidents")),
);

server.registerTool(
  "get_incident_details",
  {
    description: "Get the details of one incident by its id (e.g. INC-101)",
    inputSchema: { id: z.string().describe("Incident id") },
    annotations: readOnly,
  },
  async ({ id }) => {
    const all = await loadFixture<Record<string, unknown>>("incident_details");
    if (!(id in all)) return errorResult(`unknown incident: ${id}`);
    return jsonResult(all[id]);
  },
);

server.registerTool(
  "get_metrics",
  {
    description: 'Get a weekly metric: "deploys" or "uptime"',
    inputSchema: {
      metric: z.enum(["deploys", "uptime"]).describe("Metric name"),
      date,
    },
    annotations: readOnly,
  },
  async ({ metric }) => {
    const all = await loadFixture<Record<string, unknown>>("metrics");
    return jsonResult(all[metric]);
  },
);

registerSendMessage(server);

await server.connect(new StdioServerTransport());
