import type { Workflow, WorkflowStep } from "hotpath-shared";

// Pure workflow → React Flow graph conversion (SPEC §6 M9); no React here so
// it is unit-testable and usable from node.

export interface StepNodeData extends Record<string, unknown> {
  kind: "tool" | "llm";
  sideEffect: boolean;
  label: string;
  step: WorkflowStep;
}

export interface GraphNode {
  id: string;
  type: "step";
  position: { x: number; y: number };
  data: StepNodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_WIDTH = 240;
const COLUMN_GAP = 40;
const ROW_HEIGHT = 130;

const STEP_REF = /\{\{\s*steps\.([^.}\s]+)/g;

/** ids of earlier steps whose output a step's args/prompt reference. */
function referencedSteps(step: WorkflowStep): string[] {
  const text = JSON.stringify(step.type === "tool" ? step.args : step.prompt);
  return [...new Set([...text.matchAll(STEP_REF)].map((m) => m[1]))];
}

export function workflowToGraph(workflow: Workflow): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const known = new Set(workflow.steps.map((s) => s.id));
  const edges: GraphEdge[] = [];
  const depth = new Map<string, number>();

  for (const step of workflow.steps) {
    const deps = referencedSteps(step).filter((id) => known.has(id));
    for (const source of deps) {
      edges.push({ id: `${source}->${step.id}`, source, target: step.id });
    }
    depth.set(
      step.id,
      deps.length === 0
        ? 0
        : Math.max(...deps.map((d) => depth.get(d) ?? 0)) + 1,
    );
  }

  const countAtDepth = new Map<number, number>();
  const nodes: GraphNode[] = workflow.steps.map((step) => {
    const level = depth.get(step.id) ?? 0;
    const column = countAtDepth.get(level) ?? 0;
    countAtDepth.set(level, column + 1);
    return {
      id: step.id,
      type: "step",
      position: {
        x: column * (NODE_WIDTH + COLUMN_GAP),
        y: level * ROW_HEIGHT,
      },
      data: {
        kind: step.type,
        sideEffect: step.type === "tool" && step.sideEffect,
        label: step.type === "tool" ? step.tool : `llm (${step.model})`,
        step,
      },
    };
  });

  return { nodes, edges };
}

/** Header text: "5 steps · 1 use AI". */
export function summarize(workflow: Workflow): string {
  const ai = workflow.steps.filter((s) => s.type === "llm").length;
  return `${workflow.steps.length} steps · ${ai} use AI`;
}
