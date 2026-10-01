import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

export async function loadFixture<T = Record<string, unknown>>(
  name: string,
): Promise<T> {
  const set = process.env.DEMO_FIXTURES ?? "default";
  const file = path.join(fixturesDir, set, `${name}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}
