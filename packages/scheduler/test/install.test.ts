import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPlan,
  daemonName,
  describePlan,
  planInstall,
  planInstalled,
  systemdQuote,
  windowsQuote,
  type CommandRunner,
} from "../src/install.js";

const winCtx = {
  argv: [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\Mo Dev\\hotpath\\node_modules\\tsx\\dist\\cli.mjs",
    "C:\\Users\\Mo Dev\\hotpath\\packages\\cli\\src\\index.ts",
    "daemon",
  ],
  projectDir: "C:\\Users\\Mo Dev\\hotpath",
  home: "C:\\Users\\Mo Dev",
};

const unixCtx = {
  argv: [
    "/usr/local/bin/node",
    "/home/mo/my code/hotpath/node_modules/tsx/dist/cli.mjs",
    "/home/mo/my code/hotpath/packages/cli/src/index.ts",
    "daemon",
  ],
  projectDir: "/home/mo/my code/hotpath",
  home: "/home/mo",
  uid: 501,
};

describe("daemon install plans", () => {
  it("names the daemon per project, stably", () => {
    expect(daemonName("/a")).toBe(daemonName("/a"));
    expect(daemonName("/a")).not.toBe(daemonName("/b"));
    expect(daemonName("/a")).toMatch(/^hotpath-daemon-[0-9a-f]{8}$/);
  });

  it("Windows: a per-user logon task from XML, with paths quoted for the command line", () => {
    const plan = planInstall("win32", winCtx);
    const xml = plan.files[0]!.content;
    expect(plan.files[0]!.path.endsWith(`${plan.name}.xml`)).toBe(true);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain(
      "<Command>C:\\Program Files\\nodejs\\node.exe</Command>",
    );
    expect(xml).toContain(
      "<Arguments>&quot;C:\\Users\\Mo Dev\\hotpath\\node_modules\\tsx\\dist\\cli.mjs&quot; " +
        "&quot;C:\\Users\\Mo Dev\\hotpath\\packages\\cli\\src\\index.ts&quot; daemon</Arguments>",
    );
    expect(xml).toContain(
      "<WorkingDirectory>C:\\Users\\Mo Dev\\hotpath</WorkingDirectory>",
    );
    expect(plan.install).toEqual([
      [
        "schtasks",
        "/Create",
        "/TN",
        plan.name,
        "/XML",
        plan.files[0]!.path,
        "/F",
      ],
    ]);
    expect(plan.uninstall).toEqual([
      ["schtasks", "/Delete", "/TN", plan.name, "/F"],
    ]);
    expect(plan.status).toEqual(["schtasks", "/Query", "/TN", plan.name]);
  });

  it("macOS: a LaunchAgent plist with one string per argument", () => {
    const plan = planInstall("darwin", unixCtx);
    expect(plan.files[0]!.path).toBe(
      `/home/mo/Library/LaunchAgents/ai.hotpath.${daemonName(unixCtx.projectDir)}.plist`,
    );
    const plist = plan.files[0]!.content;
    expect(plist).toContain(
      "<string>/home/mo/my code/hotpath/packages/cli/src/index.ts</string>",
    );
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("/home/mo/my code/hotpath/.hotpath/daemon.log");
    expect(plan.install).toEqual([
      ["launchctl", "bootstrap", "gui/501", plan.files[0]!.path],
    ]);
    expect(plan.uninstall).toEqual([
      ["launchctl", "bootout", "gui/501", plan.files[0]!.path],
    ]);
  });

  it("Linux: a systemd --user unit with every argument quoted", () => {
    const plan = planInstall("linux", unixCtx);
    expect(plan.files[0]!.path).toBe(
      `/home/mo/.config/systemd/user/${plan.name}`,
    );
    const unit = plan.files[0]!.content;
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/home/mo/my code/hotpath/node_modules/tsx/dist/cli.mjs" ' +
        '"/home/mo/my code/hotpath/packages/cli/src/index.ts" "daemon"',
    );
    expect(unit).toContain('WorkingDirectory="/home/mo/my code/hotpath"');
    expect(unit).toContain("WantedBy=default.target");
    expect(plan.install).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", plan.name],
    ]);
  });

  it("escapes XML and quoting metacharacters", () => {
    const plan = planInstall("darwin", {
      ...unixCtx,
      argv: ["/bin/node", "a<b>&'\"c"],
    });
    expect(plan.files[0]!.content).toContain(
      "<string>a&lt;b&gt;&amp;&apos;&quot;c</string>",
    );
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsQuote("C:\\dir with space\\")).toBe(
      '"C:\\dir with space\\\\"',
    );
    expect(windowsQuote("plain")).toBe("plain");
    expect(systemdQuote('50% "x"\\')).toBe('"50%% \\"x\\"\\\\"');
  });

  it("describes exactly what will be written and run", () => {
    const plan = planInstall("linux", unixCtx);
    const text = describePlan(plan, "install");
    expect(text).toContain(`will write ${plan.files[0]!.path}`);
    expect(text).toContain("ExecStart=");
    expect(text).toContain(`systemctl --user enable --now ${plan.name}`);
    expect(describePlan(plan, "uninstall")).toContain(
      `will remove ${plan.files[0]!.path}`,
    );
  });
});

describe("applying a plan", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "hotpath-install-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the files, runs the commands in order, and uninstall removes them", async () => {
    const plan = planInstall("linux", { ...unixCtx, home });
    const ran: string[][] = [];
    const ok: CommandRunner = (argv) => {
      ran.push(argv);
      return { code: 0, output: "" };
    };
    await applyPlan(plan, "install", ok);
    expect(await readFile(plan.files[0]!.path, "utf8")).toBe(
      plan.files[0]!.content,
    );
    expect(ran).toEqual(plan.install);
    expect(planInstalled(plan, ok)).toBe(true);

    await applyPlan(plan, "uninstall", ok);
    await expect(readFile(plan.files[0]!.path, "utf8")).rejects.toThrow();
  });

  it("stops at the first failing command with its output", async () => {
    const plan = planInstall("linux", { ...unixCtx, home });
    const fail: CommandRunner = () => ({
      code: 1,
      output: "Failed to connect to bus",
    });
    await expect(applyPlan(plan, "install", fail)).rejects.toThrow(
      /daemon-reload.*Failed to connect to bus/,
    );
  });

  it("writes the Windows task XML as UTF-16 with a byte order mark", async () => {
    const plan = planInstall("win32", { ...winCtx, projectDir: home });
    await applyPlan(plan, "install", () => ({ code: 0, output: "" }));
    const bytes = await readFile(plan.files[0]!.path);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(plan.files[0]!.content);
  });
});
