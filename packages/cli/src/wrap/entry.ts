// Pure helpers for one MCP server entry in an agent's config. Both OpenClaw and
// Claude Code describe a stdio server as { command, args, ... } and a remote
// one with a `url`; everything else in the entry is copied untouched.

export type ServerEntry = Record<string, unknown>;

export type AgentName = "openclaw" | "claude-code";

export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

// Task names become folder names under traces/ and workflows/.
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function checkTaskName(task: string): void {
  if (!TASK_RE.test(task)) {
    throw new WrapError(
      `invalid task name ${JSON.stringify(task)} — use letters, digits, "-" and "_" (it becomes a folder name)`,
    );
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? value
    : undefined;
}

/** True when the entry already starts the Hotpath recorder. */
export function isWrapped(entry: ServerEntry): boolean {
  const args = stringArray(entry.args) ?? [];
  const i = args.indexOf("record");
  return i >= 0 && args[i + 1] === "--task" && args.indexOf("--", i + 3) > 0;
}

export function isRemote(entry: ServerEntry): boolean {
  return (
    typeof entry.url === "string" ||
    entry.type === "http" ||
    entry.type === "sse" ||
    entry.transport === "streamable-http" ||
    entry.transport === "sse"
  );
}

/** Throws a WrapError explaining why `name` can't be wrapped, if it can't. */
export function checkWrappable(
  entry: ServerEntry | undefined,
  name: string,
  agent: AgentName,
  available: string[],
): asserts entry is ServerEntry {
  if (!entry) {
    const list = available.length > 0 ? available.join(", ") : "(none)";
    throw new WrapError(
      `no MCP server named "${name}" in the ${agent} config — servers found: ${list}`,
    );
  }
  if (isRemote(entry)) {
    throw new WrapError(
      `"${name}" is a remote (url) server; Hotpath can only record stdio servers that ${agent} starts as a command`,
    );
  }
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    throw new WrapError(
      `"${name}" has no "command" in the ${agent} config, so there is nothing to wrap`,
    );
  }
  if (entry.args !== undefined && !stringArray(entry.args)) {
    throw new WrapError(
      `"${name}" has "args" that are not a list of strings; fix the ${agent} config first`,
    );
  }
  if (isWrapped(entry)) {
    throw new WrapError(
      `"${name}" is already wrapped by Hotpath — run \`hotpath unwrap ${agent} ${name}\` first`,
    );
  }
}

/**
 * The entry with its command replaced by `<self> record --task <task> -- <original>`.
 * `self` is how to start this CLI, e.g. [node, tsx cli, packages/cli/src/index.ts].
 * Key order and every other field (cwd, env, timeouts, filters) stay as they were.
 */
export function wrapEntry(
  entry: ServerEntry,
  task: string,
  self: string[],
): ServerEntry {
  const [selfCommand, ...selfArgs] = self;
  if (!selfCommand) throw new WrapError("cannot tell how to start hotpath");
  const original = [
    entry.command as string,
    ...(stringArray(entry.args) ?? []),
  ];
  return {
    ...entry,
    command: selfCommand,
    args: [...selfArgs, "record", "--task", task, "--", ...original],
  };
}

/** Line diff of two entries as pretty JSON: "  " kept, "- " removed, "+ " added. */
export function formatEntryDiff(
  before: ServerEntry,
  after: ServerEntry,
): string {
  const a = JSON.stringify(before, null, 2).split("\n");
  const b = JSON.stringify(after, null, 2).split("\n");
  // longest common subsequence table; entries are a few dozen lines at most
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i++]}`);
      j++;
    } else if (
      j < b.length &&
      (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)
    ) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  return out.join("\n");
}
