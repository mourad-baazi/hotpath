import {
  type TraceFile,
  type Workflow,
  type WorkflowStep,
} from "hotpath-shared";

// Deterministic trace → workflow compiler (SPEC §6 M5). Needs no API key.

const LLM_TEXT_MIN_CHARS = 40;

export function compileTrace(trace: TraceFile, compiledFrom: string): Workflow {
  const steps: WorkflowStep[] = [];
  // earlier steps' recorded results, for data-flow matching (rule 3)
  const earlier: Array<{ id: string; result: unknown }> = [];
  const annotationsByTool = new Map(
    trace.meta.tools.map((t) => [t.name, t.annotations]),
  );
  const readOnlyResults: Array<{ id: string; tool: string; result: unknown }> =
    [];

  const inputEntries = Object.entries(trace.meta.inputs);

  let nextId = 1;
  const newId = () => `s${nextId++}`;

  for (const call of trace.calls) {
    const annotations = annotationsByTool.get(call.tool);
    const sideEffect = !(annotations?.readOnlyHint === true);

    const args: Record<string, unknown> = {};
    const llmStepsForTool: WorkflowStep[] = [];

    for (const [key, value] of Object.entries(call.args)) {
      const inputName = inputEntries.find(([, v]) => deepEqual(v, value))?.[0];
      if (inputName !== undefined) {
        // rule 2: arg equals a trace input → template
        args[key] = `{{inputs.${inputName}}}`;
        continue;
      }

      const ref = findInEarlierSteps(value, earlier);
      if (ref !== null) {
        // rule 3: arg equals a value from an earlier step's result
        args[key] =
          ref.path === ""
            ? `{{steps.${ref.id}.result}}`
            : `{{steps.${ref.id}.result.${ref.path}}}`;
        continue;
      }

      if (typeof value === "string" && isLlmWrittenText(value)) {
        // rule 4: generated text → insert an llm step just before this one
        const llmId = newId();
        llmStepsForTool.push({
          id: llmId,
          type: "llm",
          model: "cheap",
          prompt: buildPrompt(trace.meta.task, readOnlyResults, key, call.tool),
          example: value,
          guard: {
            nonEmpty: true,
            maxChars: Math.max(3 * value.length, 500),
          },
        });
        args[key] = `{{steps.${llmId}.output}}`;
        continue;
      }

      // rule 5: constant
      args[key] = value;
    }

    const toolId = newId();
    steps.push(...llmStepsForTool);

    steps.push({
      id: toolId,
      type: "tool",
      tool: call.tool,
      args,
      sideEffect,
      // rule 7: JSON schema inferred from the recorded result
      guard: { schema: inferSchema(call.result) },
    });

    earlier.push({ id: toolId, result: call.result });
    if (!sideEffect)
      readOnlyResults.push({
        id: toolId,
        tool: call.tool,
        result: call.result,
      });
  }

  return {
    version: 1,
    task: trace.meta.task,
    compiledFrom,
    server: trace.meta.server,
    inputs: Object.fromEntries(
      inputEntries.map(([name, value]) => [
        name,
        { type: typeof value, example: value },
      ]),
    ),
    steps,
  };
}

function isLlmWrittenText(value: string): boolean {
  return value.length >= LLM_TEXT_MIN_CHARS || value.includes("\n");
}

function buildPrompt(
  task: string,
  readOnlyResults: Array<{ id: string; tool: string; result: unknown }>,
  argName: string,
  tool: string,
): string {
  const parts = [`You are compiling the task "${task}".`];
  // Templates, not recorded data: the runtime fills them with each run's results.
  for (const { id, tool: toolName } of readOnlyResults) {
    parts.push(`${id} ${toolName} result:\n{{steps.${id}.result}}`);
  }
  parts.push(
    `write the \`${argName}\` for \`${tool}\`. Use only the data above and cover every item in it.`,
  );
  return parts.join("\n\n");
}

// rule 3: find `value` inside an earlier result; returns the shortest path.
function findInEarlierSteps(
  value: unknown,
  earlier: Array<{ id: string; result: unknown }>,
): { id: string; path: string } | null {
  for (const { id, result } of earlier) {
    const path = findPath(result, value, []);
    if (path !== null) return { id, path: path.join(".") };
  }
  return null;
}

function findPath(
  node: unknown,
  value: unknown,
  path: string[],
): string[] | null {
  if (deepEqual(node, value)) return path;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findPath(node[i], value, [...path, String(i)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const found = findPath(v, value, [...path, k]);
      if (found !== null) return found;
    }
  }
  return null;
}

// rule 7: object keys observed = required; primitive types; array items from
// the first item.
export function inferSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? inferSchema(value[0]) : {},
    };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([k, v]) => [k, inferSchema(v)]),
      ),
      required: entries.map(([k]) => k),
    };
  }
  return { type: value === null ? "null" : typeof value };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
