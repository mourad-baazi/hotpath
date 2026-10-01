import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import crossSpawn from "cross-spawn";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileTaskInMemory,
  loadWorkflow,
  lostReadOnlySteps,
  saveWorkflow,
  workflowsDir,
} from "hotpath-compiler";
import {
  CHEAP_MODEL,
  chat,
  cheapReasoning,
  formatMs,
  lookupReference,
  mentions,
  renderTemplate,
  usdCost,
  type GroundingEntry,
  type StepGuard,
  type TemplateContext,
  type Workflow,
} from "hotpath-shared";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outDir = path.join(repoRoot, "out");

/** What the fallback hands to the agent command (`--task <task> --<input> <value>`). */
export interface AgentRequest {
  task: string;
  inputs: Record<string, string>;
}

export interface RunOptions {
  inputs: Record<string, string>;
  dryRun?: boolean;
  /** Stop on drift instead of running the agent (exit non-zero via DriftError). */
  noFallback?: boolean;
  /**
   * Replace the workflow after a fallback even if the recompile lost read-only
   * steps the old one had (default: warn and keep the old workflow).
   */
  acceptRecompile?: boolean;
  /** Override how the agent is run (tests); default spawns `agent` from hotpath.config.json. */
  runAgent?: (request: AgentRequest) => Promise<void>;
}

export interface StepRunResult {
  id: string;
  durationMs: number;
  ok: boolean;
}

export interface RunMetrics {
  durationMs: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  fallback: boolean;
  steps: StepRunResult[];
  /** time split: MCP server start + connect, tool steps, llm steps (all in ms) */
  connectMs: number;
  toolMs: number;
  /** llm steps' time, excluding rate-limit waiting (reported separately) */
  llmMs: number;
  /** time spent waiting on 429 retries (included in durationMs; agent's too after a fallback) */
  rateLimitWaitMs: number;
  /** tool calls actually made, in order (bench compares them with the trace) */
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** set when a guard failed */
  driftStep?: string;
  reason?: string;
  /** set when the agent fallback ran */
  agentDurationMs?: number;
  agentCostUsd?: number;
  /** after a fallback: was workflows/<task>.json replaced by the recompile? */
  recompiled?: boolean;
  /** read-only steps the recompile would have dropped (see --accept-recompile) */
  lostSteps?: string[];
}

/** A step's guard failed: the workflow no longer matches reality. */
export class DriftError extends Error {
  constructor(
    readonly stepId: string,
    readonly reason: string,
    /** a side-effect step had already run, so re-running the task would repeat it */
    readonly sideEffectRan: boolean,
    readonly metrics: RunMetrics,
  ) {
    super(`drift at ${stepId}: ${reason}`);
    this.name = "DriftError";
  }
}

export async function runTask(
  task: string,
  options: RunOptions,
): Promise<RunMetrics> {
  const workflow = await loadWorkflow(task);
  try {
    return await runWorkflow(workflow, options);
  } catch (err) {
    if (!(err instanceof DriftError)) throw err;
    console.log(`⚠ drift at ${err.stepId}: ${err.reason}`);
    if (options.noFallback || options.dryRun) {
      throw new DriftError(
        err.stepId,
        `${err.reason} (${options.dryRun ? "--dry-run" : "--no-fallback"}: agent not run)`,
        err.sideEffectRan,
        err.metrics,
      );
    }
    if (err.sideEffectRan) {
      // The agent would repeat the side effect (e.g. send the message twice).
      throw new DriftError(
        err.stepId,
        `${err.reason} — a side effect already ran, so the agent was not run; ` +
          "fix the workflow or re-record with hotpath record",
        true,
        err.metrics,
      );
    }
    return fallback(workflow, options, err);
  }
}

async function fallback(
  workflow: Workflow,
  options: RunOptions,
  drift: DriftError,
): Promise<RunMetrics> {
  const task = workflow.task;
  const agentStart = Date.now();
  console.log(`↻ falling back to the agent for "${task}"…`);
  await (options.runAgent ?? runConfiguredAgent)({
    task,
    inputs: options.inputs,
  });
  const agentDurationMs = Date.now() - agentStart;
  const agent = await readAgentRun(agentStart);
  const agentCostUsd = agent.costUsd;

  // Recompile from the trace the agent just wrote, but look before replacing:
  // if the agent skipped reads the old workflow had, the new one would
  // silently lose those data sources.
  const { workflow: next } = await compileTaskInMemory(task);
  const lostSteps = lostReadOnlySteps(workflow, next);
  const replace = lostSteps.length === 0 || options.acceptRecompile === true;
  let backup: string | null = null;
  if (replace) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = path.join(workflowsDir, `${task}.${stamp}.bak.json`);
    await copyFile(path.join(workflowsDir, `${task}.json`), backup);
    await saveWorkflow(next);
  } else {
    console.log(
      `⚠ the recompiled workflow lost read-only step(s) the previous one had: ${lostSteps.join(", ")}. ` +
        `Keeping the old workflow (workflows/${task}.json is unchanged); ` +
        "pass --accept-recompile to replace it anyway.",
    );
  }

  const metrics: RunMetrics = {
    ...drift.metrics,
    durationMs: drift.metrics.durationMs + agentDurationMs,
    costUsd: drift.metrics.costUsd + agentCostUsd,
    rateLimitWaitMs: drift.metrics.rateLimitWaitMs + agent.rateLimitWaitMs,
    fallback: true,
    driftStep: drift.stepId,
    reason: drift.reason,
    agentDurationMs,
    agentCostUsd,
    recompiled: replace,
    ...(lostSteps.length > 0 ? { lostSteps } : {}),
  };
  await writeMetrics(metrics);
  console.log(
    `✓ ${task} recovered via agent in ${(metrics.durationMs / 1000).toFixed(1)}s, ` +
      `$${metrics.costUsd.toFixed(4)}; ` +
      (backup
        ? `recompiled ${next.steps.length} steps (old workflow: ${path.relative(repoRoot, backup).replace(/\\/g, "/")})`
        : "old workflow kept"),
  );
  return metrics;
}

async function runConfiguredAgent(request: AgentRequest): Promise<void> {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, "hotpath.config.json"), "utf8"),
  ) as { tasks: Record<string, { agent: string }> };
  const entry = config.tasks[request.task];
  if (!entry) {
    throw new Error(
      `task "${request.task}" not found in hotpath.config.json — add it, or pass --no-fallback`,
    );
  }
  await runAgentCommand(entry.agent, request);
}

// Input names become `--<name>` flags, so they are restricted to a safe shape.
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * argv for the fallback agent: the configured command's words, then
 * `--task <task>` and `--<input> <value>` for every input, each as its own
 * item. Nothing is ever joined into a string a shell would parse, so a value
 * such as `$(rm -rf ~)` reaches the agent as that literal text.
 */
export function buildAgentArgv(
  agentCommand: string,
  request: AgentRequest,
): string[] {
  const argv = splitCommand(agentCommand);
  if (argv.length === 0) {
    throw new Error(
      `the "agent" command for task "${request.task}" in hotpath.config.json is empty — set it, or pass --no-fallback`,
    );
  }
  argv.push("--task", request.task);
  for (const [name, value] of Object.entries(request.inputs)) {
    if (!INPUT_NAME_RE.test(name)) {
      throw new Error(
        `invalid input name ${JSON.stringify(name)} — input names may only contain letters, digits, "_" and "-", and must start with a letter or "_" (it becomes the flag --${name})`,
      );
    }
    argv.push(`--${name}`, value);
  }
  return argv;
}

/** Runs the agent with an argv (cross-spawn handles Windows shims), never via a shell. */
export async function runAgentCommand(
  agentCommand: string,
  request: AgentRequest,
): Promise<void> {
  const [file, ...args] = buildAgentArgv(agentCommand, request);
  const printable = [file, ...args].join(" ");
  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn(file, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) =>
      reject(
        new Error(
          `could not start the agent (${printable}): ${err.message} — check the "agent" command in hotpath.config.json`,
        ),
      ),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `agent command failed (exit ${code}): ${printable} — check the agent output above`,
            ),
          ),
    );
  });
}

// The demo agent writes out/agent-run.json; other agents may not (then $0).
async function readAgentRun(
  since: number,
): Promise<{ costUsd: number; rateLimitWaitMs: number }> {
  const none = { costUsd: 0, rateLimitWaitMs: 0 };
  try {
    const file = path.join(outDir, "agent-run.json");
    const { mtimeMs } = await stat(file);
    if (mtimeMs < since - 1000) return none;
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      costUsd?: number;
      rateLimitWaitMs?: number;
    };
    return {
      costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      rateLimitWaitMs:
        typeof parsed.rateLimitWaitMs === "number" ? parsed.rateLimitWaitMs : 0,
    };
  } catch {
    return none;
  }
}

export async function runWorkflow(
  workflow: Workflow,
  options: RunOptions,
): Promise<RunMetrics> {
  const missing = Object.entries(workflow.inputs).filter(
    ([name]) => !(name in options.inputs),
  );
  if (missing.length > 0) {
    const listing = missing
      .map(
        ([name, def]) => `  ${name} (example: ${JSON.stringify(def.example)})`,
      )
      .join("\n");
    throw new Error(
      `missing required input(s) for "${workflow.task}":\n${listing}\n` +
        "pass them as --input key=value",
    );
  }

  const start = Date.now();
  const serverArgv = splitCommand(workflow.server);
  const transport = new StdioClientTransport({
    command: serverArgv[0],
    args: serverArgv.slice(1),
    cwd: repoRoot,
    env: { ...process.env } as Record<string, string>,
    // no shell: the MCP SDK starts the server with cross-spawn (handles .cmd shims)
  });
  const client = new Client({ name: "hotpath-runtime", version: "0.1.0" });
  await client.connect(transport);
  const connectMs = Date.now() - start;

  const ctx: TemplateContext = { inputs: options.inputs, steps: {} };
  const steps: StepRunResult[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let sideEffectRan = false;
  let toolMs = 0;
  let llmMs = 0;
  let rateLimitWaitMs = 0;
  const toolCalls: RunMetrics["toolCalls"] = [];

  const buildMetrics = (extra: Partial<RunMetrics> = {}): RunMetrics => ({
    durationMs: Date.now() - start,
    llmCalls,
    promptTokens,
    completionTokens,
    costUsd: usdCost(CHEAP_MODEL, promptTokens, completionTokens),
    fallback: false,
    steps,
    connectMs,
    toolMs,
    llmMs,
    rateLimitWaitMs,
    toolCalls,
    ...extra,
  });

  try {
    for (const step of workflow.steps) {
      const stepStart = Date.now();
      let stepWaitMs = 0; // rate-limit waiting inside this step
      const record = (ok: boolean) => {
        const durationMs = Date.now() - stepStart;
        steps.push({ id: step.id, durationMs, ok });
        if (step.type === "llm") llmMs += Math.max(0, durationMs - stepWaitMs);
        else toolMs += durationMs;
      };
      const drift = async (reason: string): Promise<never> => {
        record(false);
        const metrics = buildMetrics({ driftStep: step.id, reason });
        await writeMetrics(metrics);
        throw new DriftError(step.id, reason, sideEffectRan, metrics);
      };

      if (step.type === "llm") {
        // The example is from the recorded run: without the warning, small
        // models copy its facts instead of using this run's data.
        const prompt =
          `${renderTemplate(step.prompt, ctx) as string}\n\n` +
          "Use only the data above. The example below comes from an earlier run on different data, so its facts must not be copied. " +
          `Write about ${step.example.length} characters. ` +
          `Match the style and length of this example: ${step.example}`;
        const ask = async (content: string): Promise<string> => {
          const result = await chat({
            model: CHEAP_MODEL,
            messages: [{ role: "user", content }],
            reasoningEffort: cheapReasoning(),
          });
          llmCalls += result.llmCalls;
          promptTokens += result.promptTokens;
          completionTokens += result.completionTokens;
          stepWaitMs += result.rateLimitWaitMs ?? 0;
          rateLimitWaitMs += result.rateLimitWaitMs ?? 0;
          return result.text ?? "";
        };
        let text = await ask(prompt);
        let failure = checkLlmGuard(step.guard, text);
        if (failure) await drift(failure);

        // Grounding guard: the output must mention this run's values (not
        // just the example's). Ask once more, naming what was left out.
        let missing = checkGrounding(step.guard.grounding, ctx, text);
        if (missing.length > 0) {
          const list = missing.map((m) => `- ${m}`).join("\n");
          text = await ask(
            `${prompt}\n\nYour previous answer left out these items from the data, ` +
              `which must all appear in the text (verbatim):\n${list}\n` +
              "Write the complete text again, including them.",
          );
          failure = checkLlmGuard(step.guard, text);
          if (failure) await drift(failure);
          missing = checkGrounding(step.guard.grounding, ctx, text);
          if (missing.length > 0) {
            await drift(
              `llm output does not mention: ${missing.join("; ")} (grounding guard)`,
            );
          }
        }
        ctx.steps[step.id] = { output: text };
        record(true);
        continue;
      }

      const args = renderTemplate(step.args, ctx) as Record<string, unknown>;
      if (step.sideEffect && options.dryRun) {
        console.log(
          `dry-run: ${step.id} ${step.tool} would send ${JSON.stringify(args)}`,
        );
        record(true);
        continue;
      }
      toolCalls.push({ tool: step.tool, args });
      const result = await client.callTool({
        name: step.tool,
        arguments: args,
      });
      if (step.sideEffect) sideEffectRan = true;
      const value = extractResult(result);
      ctx.steps[step.id] = { result: value };
      const isError = (result as { isError?: boolean }).isError === true;
      if (isError) {
        await drift(`tool ${step.tool} returned an error: ${previewOf(value)}`);
      }
      const failure = checkToolGuard(step.guard, value);
      if (failure) await drift(failure);
      record(true);
    }
  } finally {
    await client.close();
  }

  const metrics = buildMetrics();
  await writeMetrics(metrics);
  const calls =
    metrics.llmCalls === 1 ? "1 llm call" : `${metrics.llmCalls} llm calls`;
  console.log(
    `✓ ${workflow.task} in ${(metrics.durationMs / 1000).toFixed(1)}s, $${metrics.costUsd.toFixed(4)} (${calls})` +
      ` · startup ${formatMs(metrics.connectMs)} + tools ${formatMs(metrics.toolMs)} + llm ${formatMs(metrics.llmMs)}` +
      (metrics.rateLimitWaitMs > 0
        ? ` (+${formatMs(metrics.rateLimitWaitMs)} rate-limit wait)`
        : ""),
  );
  return metrics;
}

async function writeMetrics(metrics: RunMetrics): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "hotpath-run.json"),
    JSON.stringify(metrics, null, 2),
  );
}

// strict:false — schemas are inferred from recorded results, not hand-written.
const ajv = new Ajv({ strict: false, allErrors: false });

/** Returns a human reason when the guard fails, else null. */
export function checkToolGuard(
  guard: StepGuard,
  value: unknown,
): string | null {
  if (!guard.schema) return null;
  const validate = ajv.compile(guard.schema);
  if (validate(value)) return null;
  const error = validate.errors?.[0];
  const where = error?.instancePath ? `result${error.instancePath}` : "result";
  return `${where} ${error?.message ?? "does not match the recorded schema"}`;
}

/**
 * Values the output must mention but doesn't. Each entry's paths are resolved
 * against THIS run's results; an entry whose paths no longer resolve is skipped
 * (nothing to check), and for several paths mentioning any one is enough.
 */
export function checkGrounding(
  grounding: GroundingEntry[] | undefined,
  ctx: TemplateContext,
  text: string,
): string[] {
  const missing: string[] = [];
  for (const entry of grounding ?? []) {
    const current = entry.paths
      .map((ref) => lookupReference(ref, ctx))
      .filter(
        (v): v is string | number =>
          typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v)),
      );
    if (current.length === 0) continue;
    if (current.some((v) => mentions(text, v))) continue;
    const label = String(current[0]);
    if (!missing.includes(label)) missing.push(label);
  }
  return missing;
}

export function checkLlmGuard(guard: StepGuard, text: string): string | null {
  if (guard.nonEmpty && text.trim().length === 0) {
    return "llm output is empty (guard nonEmpty)";
  }
  if (guard.maxChars !== undefined && text.length > guard.maxChars) {
    return `llm output is ${text.length} chars, exceeds maxChars ${guard.maxChars}`;
  }
  return null;
}

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

// SPEC §5.1 result extraction (same rule as the recorder).
function extractResult(result: unknown): unknown {
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (sc !== undefined) return sc;
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return content ?? null;
}

// Minimal shell-word split (handles double quotes).
function splitCommand(cmd: string): string[] {
  return (cmd.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((w) =>
    w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w,
  );
}
