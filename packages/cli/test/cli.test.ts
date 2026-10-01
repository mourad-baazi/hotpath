import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

describe("hotpath CLI", () => {
  it("--help lists the five commands", () => {
    const program = createProgram();
    const help = program.helpInformation();
    for (const cmd of ["record", "compile", "show", "run", "view"]) {
      expect(help).toContain(cmd);
    }
  });

  it("run has --dry-run, --no-fallback and --accept-recompile", () => {
    const run = createProgram().commands.find((c) => c.name() === "run")!;
    const help = run.helpInformation();
    for (const flag of ["--dry-run", "--no-fallback", "--accept-recompile"]) {
      expect(help).toContain(flag);
    }
  });
});
