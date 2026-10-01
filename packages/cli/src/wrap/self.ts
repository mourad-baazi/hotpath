import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../../..");

/**
 * argv that starts this CLI from anywhere (an agent launches it from its own
 * folder): the Node binary, then tsx when running from source, then the entry file.
 */
export function selfCommand(): string[] {
  const fromSource = import.meta.url.endsWith(".ts");
  const entry = path.join(here, "..", fromSource ? "index.ts" : "index.js");
  if (!fromSource) return [process.execPath, entry];
  // prefer the stable node_modules/tsx path over the versioned .pnpm store path
  const stable = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsx = existsSync(stable)
    ? stable
    : createRequire(import.meta.url).resolve("tsx/cli");
  return [process.execPath, tsx, entry];
}
