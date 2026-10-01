import type { ToolStep, Workflow, WorkflowStep } from "hotpath-shared";

// Pure workflow → React Flow graph conversion (SPEC §6 M9); no React here so
// it is unit-testable and usable from node.

export interface StepNodeData extends Record<string, unknown> {
  kind: "tool" | "llm" | "foreach";
  sideEffect: boolean;
  label: string;
  step: WorkflowStep | ToolStep;
}

export interface GraphNode {
  id: string;
  /** "loop" is a group drawn around its body steps */
  type: "step" | "loop";
  position: { x: number; y: number };
  data: StepNodeData;
  /** body steps sit inside their loop's group node */
  parentId?: string;
  extent?: "parent";
  style?: { width: number; height: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 90;
const COLUMN_GAP = 40;
const ROW_GAP = 40;
const LOOP_PAD = 16;
const LOOP_HEADER = 44;

const STEP_REF = /\{\{\s*steps\.([^.}\s]+)/g;

/** ids of earlier steps whose output a step's args/prompt/list reference. */
function referencedSteps(step: WorkflowStep): string[] {
  const source =
    step.type === "tool"
      ? step.args
      : step.type === "llm"
        ? step.prompt
        : [step.over, step.body.map((b) => b.args)];
  const text = JSON.stringify(source);
  return [...new Set([...text.matchAll(STEP_REF)].map((m) => m[1]))];
}

function nodeSize(step: WorkflowStep): { width: number; height: number } {
  if (step.type !== "foreach") {
    return { width: NODE_WIDTH, height: NODE_HEIGHT };
  }
  return {
    width: NODE_WIDTH + 2 * LOOP_PAD,
    height:
      LOOP_HEADER + step.body.length * (NODE_HEIGHT + LOOP_PAD) + LOOP_PAD / 2,
  };
}

function stepData(step: WorkflowStep | ToolStep): StepNodeData {
  if (step.type === "tool") {
    return {
      kind: "tool",
      sideEffect: step.sideEffect,
      label: step.tool,
      step,
    };
  }
  if (step.type === "llm") {
    return {
      kind: "llm",
      sideEffect: false,
      label: `llm (${step.model})`,
      step,
    };
  }
  return {
    kind: "foreach",
    sideEffect: step.body.some((b) => b.sideEffect),
    label: `for each ${step.as}`,
    step,
  };
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

  // a row is as tall as its tallest node (loops are taller)
  const rowHeight = new Map<number, number>();
  for (const step of workflow.steps) {
    const level = depth.get(step.id) ?? 0;
    rowHeight.set(
      level,
      Math.max(rowHeight.get(level) ?? 0, nodeSize(step).height),
    );
  }
  const rowY = (level: number) => {
    let y = 0;
    for (let l = 0; l < level; l++) {
      y += (rowHeight.get(l) ?? NODE_HEIGHT) + ROW_GAP;
    }
    return y;
  };

  const countAtDepth = new Map<number, number>();
  const nodes: GraphNode[] = [];
  for (const step of workflow.steps) {
    const level = depth.get(step.id) ?? 0;
    const column = countAtDepth.get(level) ?? 0;
    countAtDepth.set(level, column + 1);
    const position = {
      x: column * (NODE_WIDTH + 2 * LOOP_PAD + COLUMN_GAP),
      y: rowY(level),
    };
    if (step.type !== "foreach") {
      nodes.push({ id: step.id, type: "step", position, data: stepData(step) });
      continue;
    }
    // React Flow needs a parent before its children
    nodes.push({
      id: step.id,
      type: "loop",
      position,
      data: stepData(step),
      style: nodeSize(step),
    });
    step.body.forEach((body, i) => {
      nodes.push({
        id: body.id,
        type: "step",
        position: {
          x: LOOP_PAD,
          y: LOOP_HEADER + i * (NODE_HEIGHT + LOOP_PAD),
        },
        data: stepData(body),
        parentId: step.id,
        extent: "parent",
      });
    });
  }

  return { nodes, edges };
}

/** Header text: "5 steps · 1 use AI" (plus " · 1 loop" when there are loops). */
export function summarize(workflow: Workflow): string {
  const ai = workflow.steps.filter((s) => s.type === "llm").length;
  const loops = workflow.steps.filter((s) => s.type === "foreach").length;
  const loopNote = loops > 0 ? ` · ${loops} loop${loops === 1 ? "" : "s"}` : "";
  return `${workflow.steps.length} steps · ${ai} use AI${loopNote}`;
}

/** Every step, loop bodies included (for selection by id). */
export function allSteps(workflow: Workflow): Array<WorkflowStep | ToolStep> {
  return workflow.steps.flatMap<WorkflowStep | ToolStep>((s) =>
    s.type === "foreach" ? [s, ...s.body] : [s],
  );
}
