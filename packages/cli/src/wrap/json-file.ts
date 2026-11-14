import { randomBytes } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";

export interface JsonFile {
  /** real path (symlinks resolved, so writes land in the target file) */
  file: string;
  text: string;
  data: Record<string, unknown>;
  /** false when the file needed JSON5 (comments, trailing commas, …) */
  strict: boolean;
}

export async function readJsonFile(file: string): Promise<JsonFile> {
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Error(`config file not found: ${file}`);
  }
  const text = await readFile(real, "utf8");
  let data: unknown;
  let strict = true;
  try {
    data = JSON.parse(text);
  } catch {
    strict = false;
    try {
      data = JSON5.parse(text);
    } catch (err) {
      throw new Error(
        `could not parse ${real}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${real} does not contain a JSON object`);
  }
  return { file: real, text, data: data as Record<string, unknown>, strict };
}

/** Serialize `data` the way `original` was written: same indent, newline style and final newline. */
export function stringifyLike(data: unknown, original: string): string {
  const indentMatch = /^([ \t]+)\S/m.exec(original);
  const indent = indentMatch ? indentMatch[1]! : 2;
  let out = JSON.stringify(data, null, indent);
  if (/\r?\n$/.test(original)) out += "\n";
  return original.includes("\r\n") ? out.replace(/\r?\n/g, "\r\n") : out;
}

// Write to a temp file next to the target, then rename, so a crash never
// leaves a half-written agent config behind.
export async function writeFileAtomic(
  file: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await writeFile(
    tmp,
    content,
    mode === undefined ? "utf8" : { encoding: "utf8", mode },
  );
  await rename(tmp, file);
}
