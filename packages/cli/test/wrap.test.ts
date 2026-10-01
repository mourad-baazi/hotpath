import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openclawConfigPath, type OpenclawRunner } from "../src/wrap/agents.js";
import { formatEntryDiff, isWrapped, wrapEntry } from "../src/wrap/entry.js";
import { stringifyLike } from "../src/wrap/json-file.js";
import { unwrap, wrap } from "../src/wrap/wrap.js";

const SELF = ["/usr/bin/node", "/opt/hotpath/packages/cli/src/index.ts"];

let dir: string;
let stateDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hotpath-wrap-"));
  stateDir = path.join(dir, ".hotpath");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const openclawConfig = {
  gateway: { port: 18789 },
  mcp: {
    servers: {
      files: {
        command: "node",
        args: ["./dist/mcp-server.js"],
        cwd: "/srv/tools",
        requestTimeoutMs: 20000,
      },
      docs: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
      },
    },
  },
};

async function writeJson(file: string, data: unknown): Promise<string> {
  const text = JSON.stringify(data, null, 2) + "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

function openclawOpts(config: string) {
  return {
    agent: "openclaw",
    config,
    stateDir,
    self: SELF,
    openclaw: false as const,
  };
}

describe("wrapEntry", () => {
  it("routes the original command through `record` and keeps every other field", () => {
    const entry = {
      command: "node",
      args: ["s.js", "--flag"],
      cwd: "/x",
      env: { A: "${TOKEN}" },
    };
    const wrapped = wrapEntry(entry, "brief", SELF);
    expect(wrapped).toEqual({
      command: "/usr/bin/node",
      args: [
        SELF[1],
        "record",
        "--task",
        "brief",
        "--",
        "node",
        "s.js",
        "--flag",
      ],
      cwd: "/x",
      env: { A: "${TOKEN}" },
    });
    expect(Object.keys(wrapped)).toEqual(["command", "args", "cwd", "env"]);
    expect(isWrapped(wrapped)).toBe(true);
    expect(isWrapped(entry)).toBe(false);
  });

  it("keeps Windows paths with spaces as single arguments", () => {
    const self = [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\My Code\\hotpath\\cli.ts",
    ];
    const entry = {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\My Tools\\server.js"],
    };
    const wrapped = wrapEntry(entry, "t", self);
    expect(wrapped.command).toBe(self[0]);
    expect(wrapped.args).toEqual([
      self[1],
      "record",
      "--task",
      "t",
      "--",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\My Tools\\server.js",
    ]);
  });

  it("diff marks removed and added lines", () => {
    const diff = formatEntryDiff({ command: "a" }, { command: "b" });
    expect(diff).toContain('-   "command": "a"');
    expect(diff).toContain('+   "command": "b"');
    expect(diff).toContain("  {");
  });
});

describe("stringifyLike", () => {
  it("keeps tabs, CRLF and the missing final newline", () => {
    expect(stringifyLike({ a: 1 }, '{\r\n\t"a": 0\r\n}')).toBe(
      '{\r\n\t"a": 1\r\n}',
    );
    expect(stringifyLike({ a: 1 }, '{\n    "a": 0\n}\n')).toBe(
      '{\n    "a": 1\n}\n',
    );
  });
});

describe("openclaw config path", () => {
  it("prefers --config, then OPENCLAW_CONFIG_PATH, then ~/.openclaw/openclaw.json", () => {
    const home = path.join(dir, "home");
    expect(
      openclawConfigPath({
        config: "/c.json",
        env: { OPENCLAW_CONFIG_PATH: "/e.json" },
        home,
      }),
    ).toBe(path.resolve("/c.json"));
    expect(
      openclawConfigPath({ env: { OPENCLAW_CONFIG_PATH: "/e.json" }, home }),
    ).toBe(path.resolve("/e.json"));
    expect(openclawConfigPath({ env: {}, home })).toBe(
      path.join(home, ".openclaw", "openclaw.json"),
    );
  });
});

describe("wrap / unwrap openclaw (direct file edit)", () => {
  it("wraps one server, backs it up, and unwrap restores the file byte for byte", async () => {
    const file = path.join(dir, "openclaw.json");
    const original = await writeJson(file, openclawConfig);

    const result = await wrap({
      ...openclawOpts(file),
      server: "files",
      task: "brief",
    });
    expect(result.changed).toBe(true);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.mcp.servers.files).toEqual({
      command: SELF[0],
      args: [
        SELF[1],
        "record",
        "--task",
        "brief",
        "--",
        "node",
        "./dist/mcp-server.js",
      ],
      cwd: "/srv/tools",
      requestTimeoutMs: 20000,
    });
    // nothing else touched
    expect(after.mcp.servers.docs).toEqual(openclawConfig.mcp.servers.docs);
    expect(after.gateway).toEqual(openclawConfig.gateway);

    const backup = JSON.parse(await readFile(result.backupFile!, "utf8"));
    expect(backup.entry).toEqual(openclawConfig.mcp.servers.files);

    await unwrap({
      agent: "openclaw",
      server: "files",
      stateDir,
      openclaw: false,
    });
    expect(await readFile(file, "utf8")).toBe(original);
    expect(existsSync(result.backupFile!)).toBe(false);
  });

  it("--dry-run prints a diff and writes nothing", async () => {
    const file = path.join(dir, "openclaw.json");
    const original = await writeJson(file, openclawConfig);
    const result = await wrap({
      ...openclawOpts(file),
      server: "files",
      task: "brief",
      dryRun: true,
    });
    expect(result.changed).toBe(false);
    expect(result.diff).toContain('-   "command": "node"');
    expect(result.diff).toContain('+     "record"');
    expect(await readFile(file, "utf8")).toBe(original);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("refuses an unknown server and lists the ones it found", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await expect(
      wrap({ ...openclawOpts(file), server: "nope", task: "t" }),
    ).rejects.toThrow(/no MCP server named "nope".*files, docs/);
  });

  it("refuses a remote server", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await expect(
      wrap({ ...openclawOpts(file), server: "docs", task: "t" }),
    ).rejects.toThrow(/remote/);
  });

  it("refuses a server that is already wrapped", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await wrap({ ...openclawOpts(file), server: "files", task: "t" });
    await expect(
      wrap({ ...openclawOpts(file), server: "files", task: "t" }),
    ).rejects.toThrow(/already wrapped/);
  });

  it("refuses a task name that is not a safe folder name", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await expect(
      wrap({ ...openclawOpts(file), server: "files", task: "../x" }),
    ).rejects.toThrow(/invalid task name/);
  });

  it("refuses to rewrite a JSON5 file without the openclaw CLI, leaving it unchanged", async () => {
    const file = path.join(dir, "openclaw.json");
    const text = `// my config\n{ mcp: { servers: { files: { command: "node", args: ["s.js"], }, }, }, }\n`;
    await writeFile(file, text);
    await expect(
      wrap({ ...openclawOpts(file), server: "files", task: "t" }),
    ).rejects.toThrow(/JSON5.*install the OpenClaw CLI/);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("unwrap refuses when the server was never wrapped, or was edited since", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await expect(
      unwrap({ agent: "openclaw", server: "files", stateDir, openclaw: false }),
    ).rejects.toThrow(/no wrap backup/);
    await wrap({ ...openclawOpts(file), server: "files", task: "t" });
    await writeJson(file, openclawConfig); // user reverted it by hand
    await expect(
      unwrap({ agent: "openclaw", server: "files", stateDir, openclaw: false }),
    ).rejects.toThrow(/not wrapped any more/);
  });

  it.skipIf(process.platform === "win32")(
    "edits the target of a symlinked config and keeps the link",
    async () => {
      const real = path.join(dir, "real", "openclaw.json");
      await writeJson(real, openclawConfig);
      const link = path.join(dir, "link.json");
      await symlink(real, link);
      await wrap({ ...openclawOpts(link), server: "files", task: "t" });
      expect(
        JSON.parse(await readFile(real, "utf8")).mcp.servers.files.args,
      ).toContain("record");
      expect((await import("node:fs")).lstatSync(link).isSymbolicLink()).toBe(
        true,
      );
    },
  );
});

describe("wrap openclaw through the openclaw CLI", () => {
  // A fake `openclaw` that applies `mcp set` the way the real one would.
  function fakeCli(calls: string[][], apply = true): OpenclawRunner {
    return async (args, env) => {
      calls.push(args);
      if (args[0] === "--version") return { code: 0, output: "openclaw 9.9.9" };
      if (args[0] === "mcp" && args[1] === "set" && apply) {
        const file = env.OPENCLAW_CONFIG_PATH!;
        const JSON5 = (await import("json5")).default;
        const data = JSON5.parse(await readFile(file, "utf8"));
        data.mcp.servers[args[2]!] = JSON.parse(args[3]!);
        await writeFile(file, JSON.stringify(data, null, 2));
      }
      return { code: 0, output: "" };
    };
  }

  it("uses `openclaw mcp set` with the same config file, so JSON5 configs are fine", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeFile(
      file,
      `// comment\n{ mcp: { servers: { files: { command: "node", args: ["s.js"] } } } }\n`,
    );
    const calls: string[][] = [];
    await wrap({
      agent: "openclaw",
      config: file,
      server: "files",
      task: "t",
      stateDir,
      self: SELF,
      runOpenclaw: fakeCli(calls),
    });
    const set = calls.find((c) => c[1] === "set")!;
    expect(set.slice(0, 3)).toEqual(["mcp", "set", "files"]);
    expect(JSON.parse(set[3]!).args).toEqual([
      SELF[1],
      "record",
      "--task",
      "t",
      "--",
      "node",
      "s.js",
    ]);
  });

  it("fails loudly when the CLI exits 0 but did not apply the change", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await expect(
      wrap({
        agent: "openclaw",
        config: file,
        server: "files",
        task: "t",
        stateDir,
        self: SELF,
        runOpenclaw: fakeCli([], false),
      }),
    ).rejects.toThrow(/does not show the change/);
  });

  it("falls back to editing the file when the CLI is not installed", async () => {
    const file = path.join(dir, "openclaw.json");
    await writeJson(file, openclawConfig);
    await wrap({
      agent: "openclaw",
      config: file,
      server: "files",
      task: "t",
      stateDir,
      self: SELF,
      openclaw: [path.join(dir, "no-such-openclaw-binary")],
    });
    expect(
      JSON.parse(await readFile(file, "utf8")).mcp.servers.files.args,
    ).toContain("record");
  });
});

describe("wrap / unwrap claude-code", () => {
  const stdio = {
    type: "stdio",
    command: "node",
    args: ["/tools/demo.js"],
    env: { KEY: "x" },
  };

  it("wraps a user-scope server in ~/.claude.json and restores it exactly", async () => {
    const home = path.join(dir, "home");
    const file = path.join(home, ".claude.json");
    const original = await writeJson(file, {
      numStartups: 4,
      mcpServers: { demo: stdio, remote: { type: "http", url: "https://x" } },
      projects: {},
    });
    const result = await wrap({
      agent: "claude-code",
      server: "demo",
      task: "cc",
      home,
      cwd: path.join(dir, "proj"),
      stateDir,
      self: SELF,
    });
    expect(result.file).toBe(file);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.mcpServers.demo).toEqual({
      ...stdio,
      command: SELF[0],
      args: [SELF[1], "record", "--task", "cc", "--", "node", "/tools/demo.js"],
    });
    expect(after.numStartups).toBe(4);

    await unwrap({
      agent: "claude-code",
      server: "demo",
      home,
      cwd: path.join(dir, "proj"),
      stateDir,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("prefers the local scope (projects[cwd]) over project and user scopes", async () => {
    const home = path.join(dir, "home");
    const proj = path.join(dir, "proj");
    const file = path.join(home, ".claude.json");
    await writeJson(file, {
      mcpServers: { demo: stdio },
      projects: {
        [proj]: { mcpServers: { demo: { command: "local-cmd", args: [] } } },
      },
    });
    await writeJson(path.join(proj, ".mcp.json"), {
      mcpServers: { demo: { command: "project-cmd" } },
    });
    await wrap({
      agent: "claude-code",
      server: "demo",
      task: "t",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.projects[proj].mcpServers.demo.args).toContain("local-cmd");
    expect(after.mcpServers.demo).toEqual(stdio);
  });

  it("--scope project edits .mcp.json", async () => {
    const home = path.join(dir, "home");
    const proj = path.join(dir, "proj");
    await writeJson(path.join(home, ".claude.json"), {
      mcpServers: { demo: stdio },
    });
    const projectFile = path.join(proj, ".mcp.json");
    const original = await writeJson(projectFile, {
      mcpServers: { demo: { command: "project-cmd" } },
    });
    await wrap({
      agent: "claude-code",
      server: "demo",
      task: "t",
      scope: "project",
      home,
      cwd: proj,
      stateDir,
      self: SELF,
    });
    expect(
      JSON.parse(await readFile(projectFile, "utf8")).mcpServers.demo.args,
    ).toContain("project-cmd");
    await unwrap({
      agent: "claude-code",
      server: "demo",
      home,
      cwd: proj,
      stateDir,
    });
    expect(await readFile(projectFile, "utf8")).toBe(original);
  });

  it("refuses remote and unknown servers", async () => {
    const home = path.join(dir, "home");
    await writeJson(path.join(home, ".claude.json"), {
      mcpServers: { remote: { type: "http", url: "https://x" } },
    });
    const base = {
      agent: "claude-code",
      task: "t",
      home,
      cwd: dir,
      stateDir,
      self: SELF,
    };
    await expect(wrap({ ...base, server: "remote" })).rejects.toThrow(/remote/);
    await expect(wrap({ ...base, server: "demo" })).rejects.toThrow(
      /no MCP server named "demo"/,
    );
  });
});
