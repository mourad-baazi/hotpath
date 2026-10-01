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
});
