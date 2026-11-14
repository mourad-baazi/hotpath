import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  openAgentConfig,
  type ClaudeScope,
  type ConfigOptions,
} from "./agents.js";
import {
  WrapError,
  checkTaskName,
  checkWrappable,
  formatEntryDiff,
  isWrapped,
  wrapEntry,
  type AgentName,
  type ServerEntry,
} from "./entry.js";
import { writeFileAtomic } from "./json-file.js";

export interface WrapOptions extends ConfigOptions {
  agent: string;
  server: string;
  task: string;
  dryRun?: boolean;
  /** where backups live (`.hotpath/` in the repo) */
  stateDir: string;
  /** how to start this CLI (see selfCommand) */
  self: string[];
}

export interface UnwrapOptions extends ConfigOptions {
  agent: string;
  server: string;
  dryRun?: boolean;
  stateDir: string;
}

interface Backup {
  version: 1;
  agent: AgentName;
  server: string;
  file: string;
  scope?: ClaudeScope;
  cwd?: string;
  task: string;
  wrappedAt: string;
  entry: ServerEntry;
}

export interface WrapResult {
  file: string;
  diff: string;
  changed: boolean;
  backupFile?: string;
  reloadHint: string;
}

// Server names may contain characters that are awkward in file names.
function backupPath(stateDir: string, agent: string, server: string): string {
  const safe = server.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(stateDir, "wrap-backups", `${agent}-${safe}.json`);
}

export async function wrap(options: WrapOptions): Promise<WrapResult> {
  checkTaskName(options.task);
  const config = await openAgentConfig(options.agent, options.server, options);
  const entry = config.get(options.server);
  checkWrappable(entry, options.server, config.agent, config.names());
  const next = wrapEntry(entry, options.task, options.self);
  const diff = formatEntryDiff(entry, next);
  if (options.dryRun) {
    return {
      file: config.file,
      diff,
      changed: false,
      reloadHint: config.reloadHint,
    };
  }

  // backup first: if anything below fails, the original is safe on disk
  const backupFile = backupPath(options.stateDir, config.agent, options.server);
  await mkdir(path.dirname(backupFile), { recursive: true });
  const backup: Backup = {
    version: 1,
    agent: config.agent,
    server: options.server,
    file: config.file,
    ...(config.scope ? { scope: config.scope } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    task: options.task,
    wrappedAt: new Date().toISOString(),
    entry,
  };
  // the entry may carry env values (tokens), so keep the backup private
  await writeFileAtomic(
    backupFile,
    JSON.stringify(backup, null, 2) + "\n",
    0o600,
  );
  await config.set(options.server, next);
  return {
    file: config.file,
    diff,
    changed: true,
    backupFile,
    reloadHint: config.reloadHint,
  };
}

export async function unwrap(options: UnwrapOptions): Promise<WrapResult> {
  if (options.agent !== "openclaw" && options.agent !== "claude-code") {
    throw new WrapError(
      `unknown agent "${options.agent}" — use openclaw or claude-code`,
    );
  }
  const backupFile = backupPath(
    options.stateDir,
    options.agent,
    options.server,
  );
  let backup: Backup;
  try {
    backup = JSON.parse(await readFile(backupFile, "utf8")) as Backup;
  } catch {
    throw new WrapError(
      `no wrap backup for ${options.agent} server "${options.server}" (looked for ${backupFile}); ` +
        "it was never wrapped from this Hotpath folder",
    );
  }
  const config = await openAgentConfig(options.agent, options.server, {
    ...options,
    // The exact file wrap edited, except Claude Code's project scope, which is
    // found from the project folder (an explicit --config means ~/.claude.json).
    config:
      options.config ?? (backup.scope === "project" ? undefined : backup.file),
    cwd: options.cwd ?? backup.cwd,
    scope: options.scope ?? backup.scope,
  });
  const current = config.get(options.server);
  if (!current) {
    throw new WrapError(
      `"${options.server}" is no longer in ${config.file}; nothing restored (backup kept at ${backupFile})`,
    );
  }
  if (!isWrapped(current)) {
    throw new WrapError(
      `"${options.server}" in ${config.file} is not wrapped any more (it was edited since); ` +
        `nothing changed — the original entry is in ${backupFile}`,
    );
  }
  const diff = formatEntryDiff(current, backup.entry);
  if (options.dryRun) {
    return {
      file: config.file,
      diff,
      changed: false,
      reloadHint: config.reloadHint,
    };
  }
  await config.set(options.server, backup.entry);
  await rm(backupFile);
  return {
    file: config.file,
    diff,
    changed: true,
    reloadHint: config.reloadHint,
  };
}
