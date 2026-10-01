import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { traceLineSchema, type TraceMeta } from "hotpath-shared";

// repo-root traces/ whether run from src/ (tsx) or dist/ (node).
const tracesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../traces",
);

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class TraceWriter {
  readonly file: string;
  private stream: WriteStream;
  private seq = 0;

  constructor(task: string) {
    const dir = path.join(tracesDir, task);
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${timestamp()}.jsonl`);
    this.stream = createWriteStream(this.file, { flags: "a" });
  }

  write(line: unknown): void {
    this.stream.write(JSON.stringify(traceLineSchema.parse(line)) + "\n");
  }

  writeMeta(meta: Omit<TraceMeta, "type">): void {
    this.write({ type: "meta", ...meta });
  }

  nextSeq(): number {
    return ++this.seq;
  }

  writeEnd(endedAt: string): Promise<void> {
    this.write({ type: "end", endedAt, toolCalls: this.seq });
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
