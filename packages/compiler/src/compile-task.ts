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

// `hotpath compile <task> [--trace <file>]` → workflows/<task>.json
export async function compileTask(
  task: string,
  traceFile?: string,
): Promise<Workflow> {
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
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(
    path.join(workflowsDir, `${task}.json`),
    JSON.stringify(workflow, null, 2) + "\n",
  );
  return workflow;
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
