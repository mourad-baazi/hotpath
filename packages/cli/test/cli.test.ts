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

  it("--help lists the integration and scheduler commands", () => {
    const help = createProgram().helpInformation();
    for (const cmd of [
      "wrap",
      "unwrap",
      "schedule",
      "daemon",
      "run-due",
      "runs",
      "stats",
    ]) {
      expect(help).toContain(cmd);
    }
  });

  it("schedule add has the safety flags", () => {
    const schedule = createProgram().commands.find(
      (c) => c.name() === "schedule",
    )!;
    const add = schedule.commands.find((c) => c.name() === "add")!;
    const help = add.helpInformation();
    for (const flag of [
      "--cron",
      "--tz",
      "--input",
      "--allow-side-effects",
      "--fallback",
    ]) {
      expect(help).toContain(flag);
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
