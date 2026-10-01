// Pure helpers for `pnpm bench` (SPEC §7); process/file I/O lives in index.ts.

import { formatMs, mentions } from "hotpath-shared";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Timing {
  durationMs: number;
  costUsd: number;
  /** hotpath runs only: MCP server startup, tool steps, llm steps (ms) */
  connectMs?: number;
  toolMs?: number;
  llmMs?: number;
  /** time spent waiting on rate-limit retries; included in durationMs */
  rateLimitWaitMs?: number;
}

export interface Split {
  connectMs?: number;
  toolMs?: number;
  llmMs?: number;
}

export interface ScenarioResult {
  scenario: string;
  pass: boolean;
  /** the comparison agent run; null when there is none (drift) or it was skipped */
  agent: Timing | null;
  /** the hotpath run (for drift: the fallback run incl. the agent) */
  hotpath: Timing;
  /** drift only: the follow-up run on the recompiled workflow */
  recovered?: { durationMs: number; rateLimitWaitMs?: number } & Split;
  match: boolean;
  fallback: boolean;
  notes?: string[];
}

/** mustMention strings the text lacks (typographic variants count as present). */
export function missingMentions(text: string, mustMention: string[]): string[] {
  return mustMention.filter((m) => !mentions(text, m));
}

/** `tool.arg` keys whose value comes from an llm step, so they differ every run. */
export function llmArgKeys(
  steps: Array<{ type: string; tool?: string; args?: Record<string, unknown> }>,
): Set<string> {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.type !== "tool" || !step.args || !step.tool) continue;
    for (const [arg, value] of Object.entries(step.args)) {
      if (
        typeof value === "string" &&
        /^\{\{steps\.[^.}]+\.output\}\}$/.test(value)
      ) {
        keys.add(`${step.tool}.${arg}`);
      }
    }
  }
  return keys;
}

/** null when the sequences match, else a one-line reason. */
export function sequenceMatches(
  actual: ToolCall[],
  expected: ToolCall[],
  ignore: Set<string>,
): string | null {
  if (actual.length !== expected.length) {
    return `expected ${expected.length} calls, got ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a.tool !== e.tool) {
      return `call ${i + 1}: expected ${e.tool}, got ${a.tool}`;
    }
    const keys = new Set([...Object.keys(a.args), ...Object.keys(e.args)]);
    for (const key of keys) {
      if (ignore.has(`${e.tool}.${key}`)) continue;
      if (JSON.stringify(a.args[key]) !== JSON.stringify(e.args[key])) {
        return `call ${i + 1} (${e.tool}): arg ${key} is ${JSON.stringify(a.args[key])}, expected ${JSON.stringify(e.args[key])}`;
      }
    }
  }
  return null;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const dollars = (usd: number) => `$${usd.toFixed(4)}`;
/** run time with the rate-limit waiting taken out (reported beside it instead) */
const netMs = (t: { durationMs: number; rateLimitWaitMs?: number }) =>
  Math.max(0, t.durationMs - (t.rateLimitWaitMs ?? 0));

const pair = (t: Timing) =>
  `${seconds(netMs(t))} / ${dollars(t.costUsd)}` +
  ((t.rateLimitWaitMs ?? 0) > 0
    ? ` (+${seconds(t.rateLimitWaitMs ?? 0)} rate-limit wait)`
    : "");

/** "0.3s + 45ms + 1.1s": server startup + deterministic tool steps + llm steps. */
function splitCell(s: Split): string {
  if (
    s.connectMs === undefined ||
    s.toolMs === undefined ||
    s.llmMs === undefined
  ) {
    return "-";
  }
  return `${formatMs(s.connectMs)} + ${formatMs(s.toolMs)} + ${formatMs(s.llmMs)}`;
}

export function formatTable(rows: ScenarioResult[]): string {
  const header = [
    "scenario",
    "agent time / cost",
    "hotpath time / cost",
    "startup + tools + llm",
    "speedup",
    "cheaper",
    "match",
    "fallback",
  ];
  const body = rows.map((r) => {
    const hotpath = r.recovered
      ? `${pair(r.hotpath)} → ${seconds(netMs(r.recovered))}`
      : pair(r.hotpath);
    const comparable = r.agent && !r.recovered;
    const speedup = comparable
      ? `${Math.round(netMs(r.agent!) / Math.max(netMs(r.hotpath), 1))}x`
      : "-";
    const cheaper =
      comparable && r.hotpath.costUsd > 0
        ? `${Math.round(r.agent!.costUsd / r.hotpath.costUsd)}x`
        : "-";
    return [
      r.scenario,
      r.agent ? pair(r.agent) : "-",
      hotpath,
      splitCell(r.recovered ?? r.hotpath),
      speedup,
      cheaper,
      r.pass && r.match ? "✅" : "❌",
      r.fallback ? "yes → recompiled" : "no",
    ];
  });
  const all = [header, ...body];
  const widths = header.map((_, i) =>
    Math.max(...all.map((row) => row[i].length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export interface PassRate {
  scenario: string;
  passes: number;
  runs: number;
}

/** Per-scenario pass counts over several bench runs, in first-run order. */
export function passRates(runs: ScenarioResult[][]): PassRate[] {
  const rates = new Map<string, PassRate>();
  for (const run of runs) {
    for (const r of run) {
      const rate = rates.get(r.scenario) ?? {
        scenario: r.scenario,
        passes: 0,
        runs: 0,
      };
      rate.runs++;
      if (r.pass && r.match) rate.passes++;
      rates.set(r.scenario, rate);
    }
  }
  return [...rates.values()];
}

export function formatPassRates(rates: PassRate[]): string {
  const header = ["scenario", "passed", "pass rate"];
  const body = rates.map((r) => [
    r.scenario,
    `${r.passes}/${r.runs}`,
    `${Math.round((100 * r.passes) / Math.max(r.runs, 1))}%`,
  ]);
  const all = [header, ...body];
  const widths = header.map((_, i) =>
    Math.max(...all.map((row) => row[i].length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
