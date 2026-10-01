import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileTask, loadWorkflow, workflowsDir } from "hotpath-compiler";
import {
  CHEAP_MODEL,
  chat,
  renderTemplate,
  usdCost,
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
  /** tool calls actually made, in order (bench compares them with the trace) */
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** set when a guard failed */
  driftStep?: string;
  reason?: string;
  /** set when the agent fallback ran */
  agentDurationMs?: number;
  agentCostUsd?: number;
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
  const agentCostUsd = await readAgentCost(agentStart);

  // Keep the old workflow, then recompile from the trace the agent just wrote.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(workflowsDir, `${task}.${stamp}.bak.json`);
  await copyFile(path.join(workflowsDir, `${task}.json`), backup);
  const recompiled = await compileTask(task);

  const metrics: RunMetrics = {
    ...drift.metrics,
    durationMs: drift.metrics.durationMs + agentDurationMs,
    costUsd: drift.metrics.costUsd + agentCostUsd,
    fallback: true,
    driftStep: drift.stepId,
    reason: drift.reason,
    agentDurationMs,
    agentCostUsd,
  };
  await writeMetrics(metrics);
  console.log(
    `✓ ${task} recovered via agent in ${(metrics.durationMs / 1000).toFixed(1)}s, ` +
      `$${metrics.costUsd.toFixed(4)}; recompiled ${recompiled.steps.length} steps ` +
      `(old workflow: ${path.relative(repoRoot, backup).replace(/\\/g, "/")})`,
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
  const flags = Object.entries(request.inputs)
    .map(([name, value]) => `--${name} ${shellQuote(value)}`)
    .join(" ");
  const command = `${entry.agent} --task ${request.task} ${flags}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `agent command failed (exit ${code}): ${command} — check the agent output above`,
            ),
          ),
    );
  });
}

// The demo agent writes out/agent-run.json; other agents may not (then $0).
async function readAgentCost(since: number): Promise<number> {
  try {
    const file = path.join(outDir, "agent-run.json");
    const { mtimeMs } = await stat(file);
    if (mtimeMs < since - 1000) return 0;
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      costUsd?: number;
    };
    return typeof parsed.costUsd === "number" ? parsed.costUsd : 0;
  } catch {
    return 0;
  }
}

function shellQuote(value: string): string {
  return /^[\w.:@/=-]+$/.test(value)
    ? value
    : `"${value.replace(/"/g, '\\"')}"`;
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
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  const client = new Client({ name: "hotpath-runtime", version: "0.1.0" });
  await client.connect(transport);

  const ctx: TemplateContext = { inputs: options.inputs, steps: {} };
  const steps: StepRunResult[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let sideEffectRan = false;
  const toolCalls: RunMetrics["toolCalls"] = [];

  const buildMetrics = (extra: Partial<RunMetrics> = {}): RunMetrics => ({
    durationMs: Date.now() - start,
    llmCalls,
    promptTokens,
    completionTokens,
    costUsd: usdCost(CHEAP_MODEL, promptTokens, completionTokens),
    fallback: false,
    steps,
    toolCalls,
    ...extra,
  });

  try {
    for (const step of workflow.steps) {
      const stepStart = Date.now();
      const record = (ok: boolean) =>
        steps.push({ id: step.id, durationMs: Date.now() - stepStart, ok });
      const drift = async (reason: string): Promise<never> => {
        record(false);
        const metrics = buildMetrics({ driftStep: step.id, reason });
        await writeMetrics(metrics);
        throw new DriftError(step.id, reason, sideEffectRan, metrics);
      };

      if (step.type === "llm") {
        const prompt = `${renderTemplate(step.prompt, ctx) as string}\n\nMatch the style and length of this example: ${step.example}`;
        const result = await chat({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: prompt }],
        });
        llmCalls += result.llmCalls;
        promptTokens += result.promptTokens;
        completionTokens += result.completionTokens;
        const text = result.text ?? "";
        const failure = checkLlmGuard(step.guard, text);
        if (failure) await drift(failure);
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
    `✓ ${workflow.task} in ${(metrics.durationMs / 1000).toFixed(1)}s, $${metrics.costUsd.toFixed(4)} (${calls})`,
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
