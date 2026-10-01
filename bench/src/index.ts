import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestTraceFile, loadWorkflow } from "hotpath-compiler";
import { readTrace } from "hotpath-shared";

import {
  formatPassRates,
  formatTable,
  llmArgKeys,
  missingMentions,
  passRates,
  sequenceMatches,
  type ScenarioResult,
  type Timing,
  type ToolCall,
} from "./lib.js";

// `pnpm bench` (SPEC §7): real API calls; proves the loop end to end, for each
// demo task. `--skip-agent` skips the comparison agent run in new-data;
// `--task <name>` runs just one task.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outDir = path.join(repoRoot, "out");
const argv = process.argv.slice(2);
const skipAgent = argv.includes("--skip-agent");
// --runs N: repeat the whole benchmark N times and report per-scenario pass
// rates (the LLM parts are not deterministic). --skip-agent-reruns skips the
// comparison agent run in runs 2..N (saves tokens when rate limits bite).
const skipAgentReruns = argv.includes("--skip-agent-reruns");
const runsFlag = argv.includes("--runs")
  ? Number(argv[argv.indexOf("--runs") + 1])
  : 1;
if (!Number.isInteger(runsFlag) || runsFlag < 1) {
  throw new Error("--runs needs a positive integer, e.g. --runs 3");
}
const onlyTask = argv.includes("--task")
  ? argv[argv.indexOf("--task") + 1]
  : undefined;

const TASKS = ["morning-brief", "weekly-report"];
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
  recompiled?: boolean;
  lostSteps?: string[];
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

const runAgent = (task: string, date: string, fixtures: string) =>
  exec(
    ["examples/demo-agent/src/index.ts", "--task", task, "--date", date],
    fixtures,
    AGENT_TIMEOUT_MS,
  );

const hotpath = (args: string[], fixtures: string) =>
  exec(["packages/cli/src/index.ts", ...args], fixtures, RUN_TIMEOUT_MS);

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(outDir, file), "utf8")) as T;
}

/** Every message sent in the last run (weekly-report sends two). */
async function sentText(): Promise<string> {
  try {
    const messages = await readJson<Array<{ text: string }>>("messages.json");
    return messages.map((m) => m.text).join("\n\n");
  } catch {
    return "";
  }
}

async function expectedFor(task: string, fixtures: string): Promise<Expected> {
  const name =
    task === "morning-brief" ? "expected.json" : `${task}.expected.json`;
  const file = path.join(
    repoRoot,
    "examples/demo-tools/fixtures",
    fixtures,
    name,
  );
  return JSON.parse(await readFile(file, "utf8")) as Expected;
}

const clearMessages = () =>
  rm(path.join(outDir, "messages.json"), { force: true });
const readRun = () => readJson<RunFile>("hotpath-run.json").catch(() => null);

async function benchTask(
  task: string,
  skipComparisonAgent: boolean,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const label = (scenario: string) => `${task}/${scenario}`;
  const dates = {
    default: (await expectedFor(task, "default")).date,
    newData: (await expectedFor(task, "new-data")).date,
    drift: (await expectedFor(task, "drift")).date,
  };

  // 1. Setup: the agent records a trace on the default fixtures, then compile.
  console.log(
    `[${task}] setup: agent run on default fixtures (${dates.default})…`,
  );
  await clearMessages();
  const setup = await runAgent(task, dates.default, "default");
  if (setup.code !== 0) {
    throw new Error(`[${task}] setup agent run failed:\n${setup.output}`);
  }
  const setupAgent = await readJson<Timing>("agent-run.json");
  const traceFile = await latestTraceFile(task);
  const trace = await readTrace(traceFile);
  const compiled = await hotpath(
    ["compile", task, "--trace", traceFile],
    "default",
  );
  if (compiled.code !== 0) {
    throw new Error(`[${task}] compile failed:\n${compiled.output}`);
  }
  const workflow = await loadWorkflow(task);
  const ignore = llmArgKeys(workflow.steps);
  const traceCalls: ToolCall[] = trace.calls.map((c) => ({
    tool: c.tool,
    args: c.args,
  }));
  console.log(
    `[${task}] compiled ${workflow.steps.length} steps (${traceCalls.length} tool calls, ${workflow.steps.filter((s) => s.type === "llm").length} llm)`,
  );

  // 2. same-data
  console.log(`[${task}] same-data: hotpath run ${dates.default}…`);
  {
    const notes: string[] = [];
    await clearMessages();
    const run = await hotpath(
      ["run", task, "--input", `date=${dates.default}`],
      "default",
    );
    const metrics = await readRun();
    if (run.code !== 0 || !metrics) {
      notes.push(`run failed: ${run.output.trim()}`);
    }
    const expected = await expectedFor(task, "default");
    const missing = missingMentions(await sentText(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    const seq = metrics
      ? sequenceMatches(metrics.toolCalls, traceCalls, ignore)
      : "no metrics";
    if (seq) notes.push(`tool-call sequence: ${seq}`);
    if (metrics?.fallback) notes.push("unexpected fallback");
    results.push({
      scenario: label("same-data"),
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
  console.log(`[${task}] new-data: hotpath run ${dates.newData}…`);
  {
    const notes: string[] = [];
    let agent: Timing | null = null;
    if (!skipComparisonAgent) {
      await clearMessages();
      const a = await runAgent(task, dates.newData, "new-data");
      if (a.code === 0) agent = await readJson<Timing>("agent-run.json");
      else notes.push(`comparison agent run failed:\n${a.output.trim()}`);
    }
    await clearMessages();
    const run = await hotpath(
      ["run", task, "--input", `date=${dates.newData}`],
      "new-data",
    );
    const metrics = await readRun();
    if (run.code !== 0 || !metrics) {
      notes.push(`run failed: ${run.output.trim()}`);
    }
    const expected = await expectedFor(task, "new-data");
    const missing = missingMentions(await sentText(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    if (metrics?.fallback) notes.push("unexpected fallback");
    results.push({
      scenario: label("new-data"),
      pass: notes.length === 0,
      agent,
      hotpath: metrics ?? NO_TIMING,
      match: missing.length === 0,
      fallback: metrics?.fallback ?? false,
      notes,
    });
  }

  // 4. drift: guard fails at s1, fallback recompiles, the second run is clean.
  console.log(
    `[${task}] drift: hotpath run on drifted fixtures (agent + recompile)…`,
  );
  {
    const notes: string[] = [];
    await clearMessages();
    const first = await hotpath(
      ["run", task, "--input", `date=${dates.drift}`],
      "drift",
    );
    const drifted = await readRun();
    if (first.code !== 0)
      notes.push(`drift run failed:\n${first.output.trim()}`);
    if (drifted?.recompiled === false) {
      notes.push(
        `recompile rejected: the agent skipped read-only step(s) ${drifted.lostSteps?.join(", ")}`,
      );
    }
    if (!drifted?.fallback || drifted.driftStep !== "s1") {
      notes.push(
        `expected fallback after drift at s1, got fallback=${drifted?.fallback} driftStep=${drifted?.driftStep}`,
      );
    }
    await clearMessages();
    const second = await hotpath(
      ["run", task, "--input", `date=${dates.drift}`],
      "drift",
    );
    const again = await readRun();
    if (second.code !== 0 || !again) {
      notes.push(`second run failed:\n${second.output.trim()}`);
    }
    if (again?.fallback) notes.push("second run fell back again");
    const expected = await expectedFor(task, "drift");
    const missing = missingMentions(await sentText(), expected.mustMention);
    if (missing.length) notes.push(`missing mentions: ${missing.join("; ")}`);
    results.push({
      scenario: label("drift"),
      pass: notes.length === 0,
      agent: null,
      hotpath: drifted ?? NO_TIMING,
      recovered: {
        durationMs: again?.durationMs ?? 0,
        connectMs: again?.connectMs,
        toolMs: again?.toolMs,
        llmMs: again?.llmMs,
        rateLimitWaitMs: again?.rateLimitWaitMs,
      },
      match: missing.length === 0,
      fallback: drifted?.fallback ?? false,
      notes,
    });
  }
  return results;
}

async function main(): Promise<void> {
  // The demo servers run from their built output (no tsx/pnpm startup cost).
  for (const file of ["index.js", "weekly.js"]) {
    if (!existsSync(path.join(repoRoot, "examples/demo-tools/dist", file))) {
      throw new Error(
        "examples/demo-tools/dist is missing — run `pnpm --filter demo-tools build` first",
      );
    }
  }
  const tasks = onlyTask ? [onlyTask] : TASKS;
  if (!tasks.every((t) => TASKS.includes(t))) {
    throw new Error(
      `unknown task "${onlyTask}" — choose from ${TASKS.join(", ")}`,
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const allRuns: ScenarioResult[][] = [];
  for (let run = 0; run < runsFlag; run++) {
    if (runsFlag > 1) {
      console.log(`\n=== run ${run + 1} of ${runsFlag} ===`);
    }
    const skipComparison = skipAgent || (skipAgentReruns && run > 0);
    const results: ScenarioResult[] = [];
    for (const task of tasks) {
      try {
        results.push(...(await benchTask(task, skipComparison)));
      } catch (err) {
        // e.g. the setup agent run died: count the task's scenarios as failed
        // (so pass rates stay honest) instead of losing the other runs' data.
        const reason = err instanceof Error ? err.message : String(err);
        for (const scenario of ["same-data", "new-data", "drift"]) {
          results.push({
            scenario: `${task}/${scenario}`,
            pass: false,
            agent: null,
            hotpath: NO_TIMING,
            match: false,
            fallback: false,
            notes: [`${task} did not get past setup: ${reason}`],
          });
        }
      }
    }
    allRuns.push(results);

    console.log(`\n${formatTable(results)}`);
    for (const r of results) {
      for (const note of r.notes ?? []) console.log(`  ${r.scenario}: ${note}`);
    }
  }

  const rates = passRates(allRuns);
  if (runsFlag > 1) {
    console.log(
      `\npass rates over ${runsFlag} runs:\n${formatPassRates(rates)}`,
    );
  }
  await writeFile(
    path.join(repoRoot, "bench", "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runs: allRuns.map((results) => ({ results })),
        passRates: rates,
      },
      null,
      2,
    ),
  );
  const failed = allRuns.flat().filter((r) => !r.pass || !r.match);
  console.log(
    failed.length
      ? `\n❌ ${failed.length} scenario run(s) failed`
      : "\n✅ all scenarios passed",
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
