import crossSpawn from "cross-spawn";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";

import { WrapError, type AgentName, type ServerEntry } from "./entry.js";
import {
  readJsonFile,
  stringifyLike,
  writeFileAtomic,
  type JsonFile,
} from "./json-file.js";

export type ClaudeScope = "local" | "project" | "user";

/** One agent config file, narrowed to its MCP server map. */
export interface AgentConfig {
  agent: AgentName;
  file: string;
  scope?: ClaudeScope;
  /** Claude Code project folder (local and project scopes depend on it) */
  cwd?: string;
  names(): string[];
  get(name: string): ServerEntry | undefined;
  /** Replace one server entry and nothing else. */
  set(name: string, entry: ServerEntry): Promise<void>;
  /** What the user has to do for the agent to pick up the change. */
  reloadHint: string;
}

/** Runs the OpenClaw CLI; resolves with the exit code (null when it isn't installed). */
export type OpenclawRunner = (
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number | null; output: string }>;

export interface ConfigOptions {
  /** explicit config file (`--config`) */
  config?: string;
  /** Claude Code scope (`--scope`) */
  scope?: ClaudeScope;
  /** project folder for Claude Code's local and project scopes */
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** how to start the OpenClaw CLI; false never uses it */
  openclaw?: string[] | false;
  /** test hook: replaces spawning the OpenClaw CLI */
  runOpenclaw?: OpenclawRunner;
}

function servers(
  data: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  let node: unknown = data;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "object" && node !== null && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : undefined;
}

function entryOf(
  map: Record<string, unknown> | undefined,
  name: string,
): ServerEntry | undefined {
  const value = map && Object.hasOwn(map, name) ? map[name] : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ServerEntry)
    : undefined;
}

// --- OpenClaw ------------------------------------------------------------

/** `--config`, then OPENCLAW_CONFIG_PATH, then ~/.openclaw/openclaw.json (docs: gateway/configuration). */
export function openclawConfigPath(options: ConfigOptions): string {
  const env = options.env ?? process.env;
  if (options.config) return path.resolve(options.config);
  if (env.OPENCLAW_CONFIG_PATH) return path.resolve(env.OPENCLAW_CONFIG_PATH);
  return path.join(options.home ?? os.homedir(), ".openclaw", "openclaw.json");
}

function spawnRunner(command: string[]): OpenclawRunner {
  return (args, env) =>
    new Promise((resolve) => {
      const [bin, ...pre] = command;
      // argument array via cross-spawn: no shell parses the JSON we pass
      const child = crossSpawn(bin!, [...pre, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
      child.on("error", () => resolve({ code: null, output }));
      child.on("close", (code) => resolve({ code, output }));
    });
}

export async function openOpenclawConfig(
  options: ConfigOptions,
): Promise<AgentConfig> {
  const json = await readJsonFile(openclawConfigPath(options));
  const map = servers(json.data, "mcp", "servers");
  const run =
    options.runOpenclaw ??
    (options.openclaw === false
      ? undefined
      : spawnRunner(options.openclaw ?? ["openclaw"]));

  async function setWithCli(
    name: string,
    entry: ServerEntry,
  ): Promise<boolean> {
    if (!run) return false;
    // point the CLI at the same file we read, whatever its default is
    const env = { OPENCLAW_CONFIG_PATH: json.file };
    const version = await run(["--version"], env);
    if (version.code === null) return false; // not installed
    const result = await run(["mcp", "set", name, JSON.stringify(entry)], env);
    if (result.code !== 0) {
      throw new WrapError(
        `\`openclaw mcp set ${name}\` failed (exit ${result.code}): ${result.output.trim()}`,
      );
    }
    const after = entryOf(
      servers((await readJsonFile(json.file)).data, "mcp", "servers"),
      name,
    );
    if (!isDeepStrictEqual(after, entry)) {
      throw new WrapError(
        `\`openclaw mcp set ${name}\` ran but the config does not show the change; check ${json.file}`,
      );
    }
    return true;
  }

  return {
    agent: "openclaw",
    file: json.file,
    names: () => Object.keys(map ?? {}),
    get: (name) => entryOf(map, name),
    async set(name, entry) {
      if (await setWithCli(name, entry)) return;
      if (!json.strict) {
        throw new WrapError(
          `${json.file} uses JSON5 (comments or trailing commas) and the openclaw CLI was not found; ` +
            "install the OpenClaw CLI so Hotpath can edit the config without losing your comments",
        );
      }
      await writeServer(json, ["mcp", "servers"], name, entry);
    },
    reloadHint:
      "OpenClaw's Gateway picks this up on the next turn when hot reload is on; otherwise restart the Gateway.",
  };
}

// --- Claude Code ---------------------------------------------------------

function projectKeys(cwd: string): string[] {
  // Claude Code keys projects by absolute path; on Windows it may use either slash
  return [...new Set([cwd, cwd.replace(/\\/g, "/")])];
}

export async function openClaudeCodeConfig(
  name: string,
  options: ConfigOptions,
): Promise<AgentConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const userFile = options.config
    ? path.resolve(options.config)
    : path.join(options.home ?? os.homedir(), ".claude.json");
  const projectFile = path.join(cwd, ".mcp.json");

  const tryRead = async (file: string): Promise<JsonFile | undefined> => {
    try {
      return await readJsonFile(file);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("config file not found")
      )
        return undefined;
      throw err;
    }
  };
  const user = await tryRead(userFile);
  const project = options.config ? undefined : await tryRead(projectFile);

  type Place = { scope: ClaudeScope; json: JsonFile; keys: string[] };
  const places: Place[] = [];
  if (user) {
    const key = projectKeys(cwd).find((k) =>
      servers(user.data, "projects", k, "mcpServers"),
    );
    if (key)
      places.push({
        scope: "local",
        json: user,
        keys: ["projects", key, "mcpServers"],
      });
  }
  if (project)
    places.push({ scope: "project", json: project, keys: ["mcpServers"] });
  if (user) places.push({ scope: "user", json: user, keys: ["mcpServers"] });

  // Claude Code's precedence: local, then project, then user
  const candidates = options.scope
    ? places.filter((p) => p.scope === options.scope)
    : places;
  const place =
    candidates.find((p) => entryOf(servers(p.json.data, ...p.keys), name)) ??
    candidates[0];
  if (!place) {
    throw new WrapError(
      `no Claude Code config found (looked for ${userFile}${options.config ? "" : ` and ${projectFile}`})`,
    );
  }
  for (const p of places) {
    if (!p.json.strict)
      throw new WrapError(`${p.json.file} is not valid JSON; fix it first`);
  }
  const map = servers(place.json.data, ...place.keys);
  return {
    agent: "claude-code",
    file: place.json.file,
    scope: place.scope,
    cwd,
    names: () => [
      ...new Set(
        candidates.flatMap((p) =>
          Object.keys(servers(p.json.data, ...p.keys) ?? {}),
        ),
      ),
    ],
    get: (n) => entryOf(map, n),
    set: (n, entry) => writeServer(place.json, place.keys, n, entry),
    reloadHint:
      "Restart Claude Code (or start a new session) so it reconnects to the server.",
  };
}

// Re-read the file right before writing so a concurrent edit by the agent
// isn't overwritten with our stale copy; only the one entry changes.
async function writeServer(
  original: JsonFile,
  keys: string[],
  name: string,
  entry: ServerEntry,
): Promise<void> {
  const fresh = await readJsonFile(original.file);
  if (!fresh.strict) {
    throw new WrapError(
      `${fresh.file} is no longer plain JSON; refusing to rewrite it`,
    );
  }
  const map = servers(fresh.data, ...keys);
  if (!map)
    throw new WrapError(`${fresh.file} no longer has ${keys.join(".")}`);
  map[name] = entry;
  await writeFileAtomic(fresh.file, stringifyLike(fresh.data, fresh.text));
}

export async function openAgentConfig(
  agent: string,
  server: string,
  options: ConfigOptions,
): Promise<AgentConfig> {
  if (agent === "openclaw") return openOpenclawConfig(options);
  if (agent === "claude-code") return openClaudeCodeConfig(server, options);
  throw new WrapError(`unknown agent "${agent}" — use openclaw or claude-code`);
}
