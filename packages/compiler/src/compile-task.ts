import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readTrace, workflowSchema, type Workflow } from "hotpath-shared";

import { compileTrace } from "./compiler.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const tracesDir = path.join(repoRoot, "traces");
export const workflowsDir = path.join(repoRoot, "workflows");

export async function latestTraceFile(task: string): Promise<string> {
  const dir = path.join(tracesDir, task);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(
      `no traces found for task "${task}" in ${dir} — run hotpath record first`,
    );
  }
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

// Compile a trace without touching workflows/ (the runtime inspects a recompile
// before deciding whether to replace the old workflow).
export async function compileTaskInMemory(
  task: string,
  traceFile?: string,
): Promise<{ workflow: Workflow; traceFile: string }> {
  const resolved = traceFile
    ? path.resolve(traceFile)
    : await latestTraceFile(task);
  const trace = await readTrace(resolved);
  if (trace.meta.task !== task) {
    throw new Error(
      `trace task is "${trace.meta.task}" but you asked to compile "${task}" — check --trace`,
    );
  }
  const workflow = workflowSchema.parse(
    compileTrace(trace, path.relative(repoRoot, resolved).replace(/\\/g, "/")),
  );
  return { workflow, traceFile: resolved };
}

export async function saveWorkflow(workflow: Workflow): Promise<void> {
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(
    path.join(workflowsDir, `${workflow.task}.json`),
    JSON.stringify(workflow, null, 2) + "\n",
  );
}

/** "compiled 5 steps (dropped 4 failed/retried calls) → workflows/x.json (from …)" */
export function formatCompileResult(workflow: Workflow): string {
  const dropped = workflow.droppedCalls?.length ?? 0;
  const note =
    dropped > 0
      ? ` (dropped ${dropped} failed/retried call${dropped === 1 ? "" : "s"})`
      : "";
  return `compiled ${workflow.steps.length} steps${note} → workflows/${workflow.task}.json (from ${workflow.compiledFrom})`;
}

// `hotpath compile <task> [--trace <file>]` → workflows/<task>.json
export async function compileTask(
  task: string,
  traceFile?: string,
): Promise<Workflow> {
  const { workflow } = await compileTaskInMemory(task, traceFile);
  await saveWorkflow(workflow);
  return workflow;
}

/**
 * Read-only tool steps the old workflow had that the new one lacks (by tool
 * name and count), e.g. ["get_weather", "get_commits (1 of 3)"]. A recompile
 * from a run where the agent skipped reads would silently drop data sources.
 */
export function lostReadOnlySteps(old: Workflow, next: Workflow): string[] {
  const count = (w: Workflow) => {
    const counts = new Map<string, number>();
    for (const step of w.steps) {
      if (step.type === "tool" && !step.sideEffect) {
        counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);
      }
    }
    return counts;
  };
  const before = count(old);
  const after = count(next);
  const lost: string[] = [];
  for (const [tool, had] of before) {
    const has = after.get(tool) ?? 0;
    if (has >= had) continue;
    lost.push(has === 0 ? tool : `${tool} (${had - has} of ${had})`);
  }
  return lost;
}

export async function loadWorkflow(task: string): Promise<Workflow> {
  const file = path.join(workflowsDir, `${task}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `no workflow for task "${task}" — run hotpath compile ${task} first`,
    );
  }
  return workflowSchema.parse(JSON.parse(raw));
}

// `s1 tool get_emails(date={{inputs.date}})` / `s4 llm (cheap) → s5.text`
export function formatWorkflow(workflow: Workflow): string {
  const lines: string[] = [];
  for (const step of workflow.steps) {
    if (step.type === "tool") {
      const args = Object.entries(step.args)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(", ");
      const mark = step.sideEffect ? " ⚡" : "";
      lines.push(`${step.id} tool ${step.tool}(${args})${mark}`);
    } else {
      const consumer = findOutputConsumer(workflow, step.id);
      const arrow = consumer ? ` → ${consumer.stepId}.${consumer.arg}` : "";
      lines.push(`${step.id} llm (${step.model})${arrow}`);
    }
  }
  return lines.join("\n");
}

function findOutputConsumer(
  workflow: Workflow,
  llmId: string,
): { stepId: string; arg: string } | null {
  for (const step of workflow.steps) {
    if (step.type !== "tool") continue;
    for (const [arg, value] of Object.entries(step.args)) {
      if (value === `{{steps.${llmId}.output}}`)
        return { stepId: step.id, arg };
    }
  }
  return null;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
