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

import type { Workflow } from "hotpath-shared";

import { summarize, workflowToGraph, type StepNodeData } from "../graph.js";

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

const nodeTypes = { step: StepNode };

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

  const step = workflow.steps.find((s) => s.id === selected) ?? null;
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

function StepPanel({ step }: { step: Workflow["steps"][number] }) {
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
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
