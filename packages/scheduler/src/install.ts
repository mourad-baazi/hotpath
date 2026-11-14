import crossSpawn from "cross-spawn";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// `hotpath daemon install`: start the daemon at login for the current user.
// Everything here is pure (content + commands as argument arrays) so it can
// be unit-tested per platform; the CLI shows the plan, asks, then applies it.

export type InstallPlatform = "win32" | "darwin" | "linux";

export interface InstallContext {
  /** argv that starts `hotpath daemon` (absolute paths) */
  argv: string[];
  /** project folder: the daemon runs here and uses its .hotpath/ */
  projectDir: string;
  home: string;
  /** macOS: numeric user id for launchctl's gui/<uid> domain */
  uid?: number;
}

export interface InstallPlan {
  platform: InstallPlatform;
  /** identifies this project's daemon (several projects can each have one) */
  name: string;
  files: Array<{ path: string; content: string }>;
  install: string[][];
  uninstall: string[][];
  /** exits 0 when installed */
  status: string[];
}

/** Stable per project folder, so re-installing replaces the same entry. */
export function daemonName(projectDir: string): string {
  const hash = createHash("sha256")
    .update(path.resolve(projectDir))
    .digest("hex")
    .slice(0, 8);
  return `hotpath-daemon-${hash}`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Windows command-line quoting for one argument (CommandLineToArgvW rules). */
export function windowsQuote(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

/** systemd ExecStart quoting: every argument double-quoted, \ " and % escaped. */
export function systemdQuote(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function windowsTaskXml(ctx: InstallContext): string {
  const [command, ...args] = ctx.argv;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Hotpath daemon for ${xmlEscape(ctx.projectDir)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command!)}</Command>
      <Arguments>${xmlEscape(args.map(windowsQuote).join(" "))}</Arguments>
      <WorkingDirectory>${xmlEscape(ctx.projectDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function launchdPlist(ctx: InstallContext, label: string): string {
  const log = path.join(ctx.projectDir, ".hotpath", "daemon.log");
  const args = ctx.argv
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ctx.projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(ctx: InstallContext): string {
  return `[Unit]
Description=Hotpath daemon for ${ctx.projectDir.replace(/\n/g, " ")}

[Service]
Type=simple
WorkingDirectory=${systemdQuote(ctx.projectDir)}
ExecStart=${ctx.argv.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
`;
}

export function planInstall(
  platform: InstallPlatform,
  ctx: InstallContext,
): InstallPlan {
  if (ctx.argv.length === 0) throw new Error("no daemon command to install");
  const name = daemonName(ctx.projectDir);
  if (platform === "win32") {
    const xml = path.join(ctx.projectDir, ".hotpath", `${name}.xml`);
    return {
      platform,
      name,
      files: [{ path: xml, content: windowsTaskXml(ctx) }],
      install: [["schtasks", "/Create", "/TN", name, "/XML", xml, "/F"]],
      uninstall: [["schtasks", "/Delete", "/TN", name, "/F"]],
      status: ["schtasks", "/Query", "/TN", name],
    };
  }
  if (platform === "darwin") {
    const label = `ai.hotpath.${name}`;
    const plist = path.join(
      ctx.home,
      "Library",
      "LaunchAgents",
      `${label}.plist`,
    );
    const domain = `gui/${ctx.uid ?? 501}`;
    return {
      platform,
      name: label,
      files: [{ path: plist, content: launchdPlist(ctx, label) }],
      install: [["launchctl", "bootstrap", domain, plist]],
      uninstall: [["launchctl", "bootout", domain, plist]],
      status: ["launchctl", "print", `${domain}/${label}`],
    };
  }
  const unit = `${name}.service`;
  const unitFile = path.join(ctx.home, ".config", "systemd", "user", unit);
  return {
    platform,
    name: unit,
    files: [{ path: unitFile, content: systemdUnit(ctx) }],
    install: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit],
    ],
    uninstall: [
      ["systemctl", "--user", "disable", "--now", unit],
      ["systemctl", "--user", "daemon-reload"],
    ],
    status: ["systemctl", "--user", "is-enabled", unit],
  };
}

/** Human-readable plan for the confirmation prompt. */
export function describePlan(
  plan: InstallPlan,
  action: "install" | "uninstall",
): string {
  const lines: string[] = [];
  if (action === "install") {
    for (const f of plan.files) {
      lines.push(`will write ${f.path}:`, "", f.content.trimEnd(), "");
    }
  } else {
    for (const f of plan.files) lines.push(`will remove ${f.path}`);
  }
  lines.push("will run:");
  for (const cmd of plan[action]) lines.push(`  ${cmd.join(" ")}`);
  return lines.join("\n");
}

export interface CommandResult {
  code: number | null;
  output: string;
}
export type CommandRunner = (argv: string[]) => CommandResult;

export function defaultCommandRunner(argv: string[]): CommandResult {
  const [bin, ...args] = argv;
  // argument arrays only: nothing here goes through a shell
  const r = crossSpawn.sync(bin!, args, { encoding: "utf8" });
  return {
    code: r.error ? null : r.status,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`,
  };
}

/** Write the files and run the commands of a plan, stopping at the first failure. */
export async function applyPlan(
  plan: InstallPlan,
  action: "install" | "uninstall",
  run: CommandRunner = defaultCommandRunner,
): Promise<void> {
  if (action === "install") {
    for (const f of plan.files) {
      await mkdir(path.dirname(f.path), { recursive: true });
      // Task Scheduler reads its XML as UTF-16 (with a byte order mark)
      const body =
        plan.platform === "win32" && f.path.endsWith(".xml")
          ? Buffer.from(`\ufeff${f.content}`, "utf16le")
          : f.content;
      await writeFile(f.path, body);
    }
  }
  for (const argv of plan[action]) {
    const r = run(argv);
    if (r.code !== 0) {
      throw new Error(
        `\`${argv.join(" ")}\` failed (exit ${r.code ?? "not started"}): ${r.output.trim()}`,
      );
    }
  }
  if (action === "uninstall") {
    for (const f of plan.files) await rm(f.path, { force: true });
  }
}

export function planInstalled(
  plan: InstallPlan,
  run: CommandRunner = defaultCommandRunner,
): boolean {
  return run(plan.status).code === 0;
}
