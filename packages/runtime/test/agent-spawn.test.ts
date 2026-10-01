import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentArgv, runAgentCommand } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const echoScript = path.join(here, "fixtures", "argv-echo.mjs");
const exitScript = path.join(here, "fixtures", "exit-3.mjs");
const scratch = path.join(repoRoot, "out", "agent-spawn-test");
const argvOut = path.join(scratch, "argv.json");

describe("buildAgentArgv", () => {
  it("splits the agent command and appends --task and one --<name> <value> pair per input", () => {
    expect(
      buildAgentArgv("pnpm --filter demo-agent start --", {
        task: "morning-brief",
        inputs: { date: "2026-10-01", city: "New York" },
      }),
    ).toEqual([
      "pnpm",
      "--filter",
      "demo-agent",
      "start",
      "--",
      "--task",
      "morning-brief",
      "--date",
      "2026-10-01",
      "--city",
      "New York", // one argv item, spaces and all
    ]);
  });

  it("keeps quoted words of the agent command together", () => {
    expect(
      buildAgentArgv('node "C:/My Tools/agent.js"', { task: "t", inputs: {} }),
    ).toEqual(["node", "C:/My Tools/agent.js", "--task", "t"]);
  });

  it("an empty agent command is a clear error", () => {
    expect(() => buildAgentArgv("   ", { task: "t", inputs: {} })).toThrow(
      /agent.*hotpath\.config\.json is empty/i,
    );
  });

  it("accepts ordinary input names", () => {
    for (const name of ["date", "week_start", "a-b", "_x", "Date2"]) {
      expect(() =>
        buildAgentArgv("a", { task: "t", inputs: { [name]: "v" } }),
      ).not.toThrow();
    }
  });

  it.each([
    "da te",
    "date;rm",
    "$(id)",
    "1abc",
    "-date",
    "--date",
    "a=b",
    "",
    "date\n",
  ])("rejects the input name %j with a message naming the rule", (name) => {
    expect(() =>
      buildAgentArgv("a", { task: "t", inputs: { [name]: "v" } }),
    ).toThrow(/invalid input name.*letters, digits/is);
  });
});

describe("runAgentCommand: values are data, never shell syntax", () => {
  beforeEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    process.env.ARGV_OUT = argvOut;
  });
  afterEach(async () => {
    delete process.env.ARGV_OUT;
    await rm(scratch, { recursive: true, force: true });
  });

  const agent = `node "${echoScript}"`;

  it("passes an ordinary value through", async () => {
    await runAgentCommand(agent, {
      task: "morning-brief",
      inputs: { date: "2026-10-01" },
    });
    expect(JSON.parse(await readFile(argvOut, "utf8"))).toEqual([
      "--task",
      "morning-brief",
      "--date",
      "2026-10-01",
    ]);
  }, 30_000);

  it("passes $(echo pwned) literally and never runs it", async () => {
    const marker = path.join(scratch, "pwned-by-substitution");
    const value = `$(echo pwned > "${marker}")`;
    await runAgentCommand(agent, { task: "t", inputs: { note: value } });

    const argv = JSON.parse(await readFile(argvOut, "utf8"));
    expect(argv).toEqual(["--task", "t", "--note", value]); // literal, byte for byte
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("also neutralizes backticks, semicolons, pipes, redirects and quotes", async () => {
    const marker = path.join(scratch, "pwned-by-metachar");
    const values = [
      `\`echo pwned > "${marker}"\``,
      `x; echo pwned > "${marker}"`,
      `x && echo pwned > "${marker}"`,
      `x | echo pwned > "${marker}"`,
      `x" ; echo pwned > "${marker}" ; echo "`,
      `x' ; echo pwned > '${marker}`,
      `%COMSPEC% & echo pwned > "${marker}"`,
    ];
    for (const value of values) {
      await runAgentCommand(agent, { task: "t", inputs: { note: value } });
      const argv = JSON.parse(await readFile(argvOut, "utf8"));
      expect(argv).toEqual(["--task", "t", "--note", value]);
      expect(existsSync(marker)).toBe(false);
    }
  }, 60_000);

  it("a malicious TASK name is data too", async () => {
    const marker = path.join(scratch, "pwned-by-task");
    const task = `t; echo pwned > "${marker}"`;
    await runAgentCommand(agent, { task, inputs: {} });
    expect(JSON.parse(await readFile(argvOut, "utf8"))).toEqual([
      "--task",
      task,
    ]);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("an invalid input name is rejected before anything is started", async () => {
    await expect(
      runAgentCommand(agent, {
        task: "t",
        inputs: { "date; echo pwned": "x" },
      }),
    ).rejects.toThrow(/invalid input name/i);
    expect(existsSync(argvOut)).toBe(false); // the agent never ran
  });

  it("a failing agent reports its exit code and the command", async () => {
    await expect(
      runAgentCommand(`node "${exitScript}"`, { task: "t", inputs: {} }),
    ).rejects.toThrow(/exit 3/);
  }, 30_000);

  it("a missing program is a readable error, not a crash", async () => {
    await expect(
      runAgentCommand("definitely-not-a-real-program-xyz", {
        task: "t",
        inputs: {},
      }),
    ).rejects.toThrow(/definitely-not-a-real-program-xyz/);
  }, 30_000);
});
