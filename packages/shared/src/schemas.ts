import { z } from "zod";

// Trace (SPEC §5.1) — one JSON object per line: meta, tool_call*, end.
export const traceToolInfoSchema = z.object({
  name: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type TraceToolInfo = z.infer<typeof traceToolInfoSchema>;

export const traceMetaSchema = z.object({
  type: z.literal("meta"),
  version: z.literal(1),
  task: z.string(),
  startedAt: z.string(),
  server: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  tools: z.array(traceToolInfoSchema),
});
export type TraceMeta = z.infer<typeof traceMetaSchema>;

export const traceToolCallSchema = z.object({
  type: z.literal("tool_call"),
  seq: z.number().int().positive(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  isError: z.boolean(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
});
export type TraceToolCall = z.infer<typeof traceToolCallSchema>;

export const traceEndSchema = z.object({
  type: z.literal("end"),
  endedAt: z.string(),
  toolCalls: z.number().int().nonnegative(),
});
export type TraceEnd = z.infer<typeof traceEndSchema>;

export const traceLineSchema = z.discriminatedUnion("type", [
  traceMetaSchema,
  traceToolCallSchema,
  traceEndSchema,
]);
export type TraceLine = z.infer<typeof traceLineSchema>;

// Workflow (SPEC §5.2) — compiled from a trace by packages/compiler.
export const stepGuardSchema = z.object({
  /** tool steps: JSON schema inferred from the recorded result */
  schema: z.record(z.string(), z.unknown()).optional(),
  /** llm steps */
  nonEmpty: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
});
export type StepGuard = z.infer<typeof stepGuardSchema>;

export const toolStepSchema = z.object({
  id: z.string(),
  type: z.literal("tool"),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  sideEffect: z.boolean(),
  guard: stepGuardSchema,
});
export type ToolStep = z.infer<typeof toolStepSchema>;

export const llmStepSchema = z.object({
  id: z.string(),
  type: z.literal("llm"),
  model: z.string(),
  prompt: z.string(),
  example: z.string(),
  guard: stepGuardSchema,
});
export type LlmStep = z.infer<typeof llmStepSchema>;

export const workflowStepSchema = z.discriminatedUnion("type", [
  toolStepSchema,
  llmStepSchema,
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowInputSchema = z.object({
  type: z.string(),
  example: z.unknown(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowSchema = z.object({
  version: z.literal(1),
  task: z.string(),
  compiledFrom: z.string(),
  server: z.string(),
  inputs: z.record(z.string(), workflowInputSchema),
  steps: z.array(workflowStepSchema),
});
export type Workflow = z.infer<typeof workflowSchema>;
