import { readFile } from "node:fs/promises";

import {
  traceEndSchema,
  traceLineSchema,
  traceMetaSchema,
  traceToolCallSchema,
  type TraceEnd,
  type TraceMeta,
  type TraceToolCall,
} from "./schemas.js";

export interface TraceFile {
  meta: TraceMeta;
  calls: TraceToolCall[];
  end: TraceEnd;
}

// Read a .jsonl trace, validating every line against the schema.
export async function readTrace(file: string): Promise<TraceFile> {
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const parsed = lines.map((l) => traceLineSchema.parse(JSON.parse(l)));
  const meta = parsed.find((l) => l.type === "meta");
  const end = parsed.find((l) => l.type === "end");
  if (!meta || !end) {
    throw new Error(`trace ${file} is missing a meta or end line`);
  }
  const calls = parsed
    .filter((l) => l.type === "tool_call")
    .map((l) => traceToolCallSchema.parse(l));
  return {
    meta: traceMetaSchema.parse(meta),
    calls,
    end: traceEndSchema.parse(end),
  };
}
