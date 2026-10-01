import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestTraceFile, loadWorkflow } from "hotpath-compiler";
import { readTrace } from "hotpath-shared";

import {
  formatTable,
  llmArgKeys,
  missingMentions,
  sequenceMatches,
  type ScenarioResult,
  type Timing,
  type ToolCall,
} from "./lib.js";

// `pnpm bench` (SPEC §7): real API calls; proves the loop end to end.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outDir = path.join(repoRoot, "out");
const TASK = "morning-brief";
const skipAgent = process.argv.includes("--skip-agent");

const AGENT_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const NO_TIMING: Timing = { durationMs: 0, costUsd: 0 };

interface Expected {
  date: string;
  mustMention: string[];
}

interface RunFile extends Timing {
  fallback: boolean;
  driftStep?: string;
  toolCalls: ToolCall[];
}

function exec(
  args: string[],
  fixtures: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // Same node + tsx the repo scripts use; avoids a pnpm hop per invocation.
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: repoRoot,
      env: { ...process.env, DEMO_FIXTURES: fixtures },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const runAgent = (date: string, fixtures: string) =>
  exec(
    ["examples/demo-agent/src/index.ts", "--task", TASK, "--date", date],
    fixtures,
    AGENT_TIMEOUT_MS,
  );

const hotpath = (args: string[], fixtures: string) =>
  exec(["packages/cli/src/index.ts", ...args], fixtures, RUN_TIMEOUT_MS);

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(outDir, file), "utf8")) as T;
}

async function lastMessage(): Promise<string> {
  try {
    const messages = await readJson<Array<{ text: string }>>("messages.json");
    return messages.at(-1)?.text ?? "";
  } catch {
    return "";
  }
}

async function expectedFor(fixtures: string): Promise<Expected> {
  const file = path.join(
    repoRoot,
    "examples/demo-tools/fixtures",
    fixtures,
    "expected.json",
  );
  return JSON.parse(await readFile(file, "utf8")) as Expected;
}

const clearMessages = () =>
  rm(path.join(outDir, "messages.json"), { force: true });
const readRun = () => readJson<RunFile>("hotpath-run.json").catch(() => null);

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  // 1. Setup: the agent records a trace on the default fixtures, then compile.
  console.log("setup: agent run on default fixtures (2026-10-01)…");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const setup = await runAgent("2026-10-01", "default");
  if (setup.code !== 0) {
    throw new Error(`setup agent run failed:\n${setup.output}`);
  }
  const setupAgent = await readJson<Timing>("agent-run.json");
  const traceFile = await latestTraceFile(TASK);
  const trace = await readTrace(traceFile);
  const compiled = await hotpath(
    ["compile", TASK, "--trace", traceFile],
    "default",
  );
  if (compiled.code !== 0) {
    throw new Error(`compile failed:\n${compiled.output}`);
  }
  const workflow = await loadWorkflow(TASK);
  const ignore = llmArgKeys(workflow.steps);
  const traceCalls: ToolCall[] = trace.calls.map((c) => ({
    tool: c.tool,
    args: c.args,
  }));

  // 2. same-data
  console.log("same-data: hotpath run 2026-10-01…");
  {
    const notes: string[] = [];
    await clearMessages();
    const run = await hotpath(
      ["run", TASK, "--input", "date=2026-10-01"],
      "default",
    );
    const metrics = await readRun();
    if (run.code !== 0 || !metrics) {
      notes.push(`run failed: ${run.output.trim()}`);
    }
    const expected = await expectedFor("default");
    const missing = missingMentions(await lastMessage(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    const seq = metrics
      ? sequenceMatches(metrics.toolCalls, traceCalls, ignore)
      : "no metrics";
    if (seq) notes.push(`tool-call sequence: ${seq}`);
    if (metrics?.fallback) notes.push("unexpected fallback");
    results.push({
      scenario: "same-data",
      pass: notes.length === 0,
      agent: setupAgent,
      hotpath: metrics ?? NO_TIMING,
      match: missing.length === 0 && !seq,
      fallback: metrics?.fallback ?? false,
      notes,
    });
  }

  // 3. new-data: the agent run is only for the cost/time comparison; we do
  // NOT recompile from its trace.
  console.log("new-data: hotpath run 2026-10-02…");
  {
    const notes: string[] = [];
    let agent: Timing | null = null;
    if (!skipAgent) {
      const a = await runAgent("2026-10-02", "new-data");
      if (a.code === 0) agent = await readJson<Timing>("agent-run.json");
      else notes.push(`comparison agent run failed:\n${a.output.trim()}`);
    }
    await clearMessages();
    const run = await hotpath(
      ["run", TASK, "--input", "date=2026-10-02"],
      "new-data",
    );
    const metrics = await readRun();
    if (run.code !== 0 || !metrics) {
      notes.push(`run failed: ${run.output.trim()}`);
    }
    const expected = await expectedFor("new-data");
    const missing = missingMentions(await lastMessage(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    if (metrics?.fallback) notes.push("unexpected fallback");
    results.push({
      scenario: "new-data",
      pass: notes.length === 0,
      agent,
      hotpath: metrics ?? NO_TIMING,
      match: missing.length === 0,
      fallback: metrics?.fallback ?? false,
      notes,
    });
  }

  // 4. drift: guard fails at s1, fallback recompiles, the second run is clean.
  console.log("drift: hotpath run on drifted fixtures (agent + recompile)…");
  {
    const notes: string[] = [];
    await clearMessages();
    const first = await hotpath(
      ["run", TASK, "--input", "date=2026-10-01"],
      "drift",
    );
    const drifted = await readRun();
    if (first.code !== 0)
      notes.push(`drift run failed:\n${first.output.trim()}`);
    if (!drifted?.fallback || drifted.driftStep !== "s1") {
      notes.push(
        `expected fallback after drift at s1, got fallback=${drifted?.fallback} driftStep=${drifted?.driftStep}`,
      );
    }
    await clearMessages();
    const second = await hotpath(
      ["run", TASK, "--input", "date=2026-10-01"],
      "drift",
    );
    const again = await readRun();
    if (second.code !== 0 || !again) {
      notes.push(`second run failed:\n${second.output.trim()}`);
    }
    if (again?.fallback) notes.push("second run fell back again");
    const expected = await expectedFor("drift");
    const missing = missingMentions(await lastMessage(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    results.push({
      scenario: "drift",
      pass: notes.length === 0,
      agent: null,
      hotpath: drifted ?? NO_TIMING,
      recovered: { durationMs: again?.durationMs ?? 0 },
      match: missing.length === 0,
      fallback: drifted?.fallback ?? false,
      notes,
    });
  }

  console.log(`\n${formatTable(results)}`);
  for (const r of results) {
    for (const note of r.notes ?? []) console.log(`  ${r.scenario}: ${note}`);
  }
  await writeFile(
    path.join(repoRoot, "bench", "results.json"),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  const failed = results.filter((r) => !r.pass || !r.match);
  console.log(
    failed.length
      ? `\n❌ ${failed.length} scenario(s) failed`
      : "\n✅ all scenarios passed",
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
