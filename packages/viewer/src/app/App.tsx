import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";

import type { ToolStep, Workflow, WorkflowStep } from "hotpath-shared";

import {
  allSteps,
  summarize,
  workflowToGraph,
  type StepNodeData,
} from "../graph.js";

function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const classes = [
    "step",
    data.kind === "llm" ? "step-llm" : "step-tool",
    data.sideEffect ? "step-effect" : "",
    selected ? "step-selected" : "",
  ].join(" ");
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} />
      <div className="step-id">{data.step.id}</div>
      <div className="step-label">{data.label}</div>
      <div className="step-tags">
        {data.kind === "llm" && <span className="tag tag-ai">AI</span>}
        {data.sideEffect && (
          <span className="tag tag-effect">⚡ side effect</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function LoopNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const step = data.step;
  return (
    <div className={`loop ${selected ? "step-selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="loop-header">
        <span className="tag tag-loop">↻ loop</span>
        <span className="step-id">{step.id}</span>
        <span className="loop-label">{data.label}</span>
        {step.type === "foreach" && (
          <span className="loop-max">max {step.maxItems}</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { step: StepNode, loop: LoopNode };

export function App() {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workflow")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return (await res.json()) as Workflow;
      })
      .then(setWorkflow)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const graph = useMemo(
    () => (workflow ? workflowToGraph(workflow) : null),
    [workflow],
  );

  if (error) return <div className="message error">{error}</div>;
  if (!workflow || !graph) return <div className="message">Loading…</div>;

  const step = allSteps(workflow).find((s) => s.id === selected) ?? null;
  const edges: Edge[] = graph.edges;

  return (
    <div className="layout">
      <header>
        <strong>{workflow.task}</strong>
        <span className="summary">{summarize(workflow)}</span>
        <span className="legend">
          <span className="tag">tool</span>
          <span className="tag tag-ai">AI</span>
          <span className="tag tag-effect">⚡ side effect</span>
          <span className="tag tag-loop">↻ loop</span>
        </span>
      </header>
      <main>
        <div className="canvas">
          <ReactFlow
            nodes={graph.nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            fitView
            onNodeClick={(_, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(null)}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside>
          {step ? (
            <StepPanel step={step} />
          ) : (
            <p className="hint">
              Select a step to see its args, prompt and guard.
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}

function StepPanel({ step }: { step: WorkflowStep | ToolStep }) {
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
  if (step.type === "foreach") {
    return (
      <div>
        <h2>
          {step.id} · for each {step.as}
        </h2>
        <h3>Over</h3>
        <pre>{step.over}</pre>
        <p>
          Runs {step.body.length === 1 ? "its step" : "its steps"} once per
          item, in order, up to {step.maxItems} items. Inside, {"{{"}
          {step.as}.…{"}}"} is the current item; afterwards {"{{"}steps.
          {step.id}.results{"}}"} is the list of results.
        </p>
      </div>
    );
  }
  return (
    <div>
      <h2>
        {step.id} · {step.type === "tool" ? step.tool : `llm (${step.model})`}
      </h2>
      {step.type === "tool" ? (
        <>
          <h3>Args</h3>
          <pre>{pretty(step.args)}</pre>
          <p>{step.sideEffect ? "⚡ has side effects" : "read-only"}</p>
        </>
      ) : (
        <>
          <h3>Prompt</h3>
          <pre>{step.prompt}</pre>
          <h3>Example output</h3>
          <pre>{step.example}</pre>
        </>
      )}
      <h3>Guard</h3>
      <pre>{pretty(step.guard)}</pre>
    </div>
  );
}
