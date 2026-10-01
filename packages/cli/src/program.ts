import { Command, InvalidArgumentError } from "commander";

import {
  compileTask,
  formatCompileResult,
  formatWorkflow,
  loadWorkflow,
} from "hotpath-compiler";
import { runRecorder } from "hotpath-recorder";
import { runTask } from "hotpath-runtime";
import { startViewer } from "hotpath-viewer";

function passthroughArgs(): string[] {
  const dash = process.argv.indexOf("--");
  return dash >= 0 ? process.argv.slice(dash + 1) : [];
}

function collectInputs(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new InvalidArgumentError("expected key=value");
  }
  previous[value.slice(0, eq)] = value.slice(eq + 1);
  return previous;
}

export function createProgram(): Command {
  const program = new Command();
  program.name("hotpath").description("JIT compiler for AI agent tasks");

  program
    .command("record")
    .description("Record an agent run through an MCP proxy")
    .requiredOption("--task <name>", "task name")
    .allowExcessArguments(true)
    .action(async (options: { task: string }) => {
      const serverArgv = passthroughArgs();
      if (serverArgv.length === 0) {
        console.error(
          "usage: hotpath record --task <name> -- <server command…>",
        );
        process.exit(1);
      }
      await runRecorder({ task: options.task, serverArgv });
    });

  program
    .command("compile")
    .description("Compile a trace into a workflow")
    .argument("<task>", "task name")
    .option("--trace <file>", "trace file (default: latest trace for the task)")
    .action(async (task: string, options: { trace?: string }) => {
      const workflow = await compileTask(task, options.trace);
      console.log(formatCompileResult(workflow));
    });

  program
    .command("show")
    .description("Show a workflow as a readable list of steps")
    .argument("<task>", "task name")
    .action(async (task: string) => {
      console.log(formatWorkflow(await loadWorkflow(task)));
    });

  program
    .command("run")
    .description("Run a compiled workflow")
    .argument("<task>", "task name")
    .option(
      "--input <key=value...>",
      "workflow inputs",
      collectInputs,
      {} as Record<string, string>,
    )
    .option(
      "--dry-run",
      "skip side-effect steps and print what they would send",
    )
    .option(
      "--no-fallback",
      "on drift, exit non-zero instead of falling back to the agent",
    )
    .option(
      "--accept-recompile",
      "after a fallback, replace the workflow even if the recompile lost read-only steps",
    )
    .action(
      async (
        task: string,
        options: {
          input: Record<string, string>;
          dryRun?: boolean;
          fallback: boolean;
          acceptRecompile?: boolean;
        },
      ) => {
        try {
          await runTask(task, {
            inputs: options.input,
            dryRun: options.dryRun,
            noFallback: !options.fallback,
            acceptRecompile: options.acceptRecompile,
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );

  program
    .command("view")
    .description("Open the workflow graph viewer")
    .argument("<task>", "task name")
    .option("--port <port>", "port for the local viewer server", "5173")
    .option("--no-open", "don't open the browser")
    .action(async (task: string, options: { port: string; open: boolean }) => {
      try {
        const viewer = await startViewer(task, {
          port: Number(options.port),
          open: options.open,
        });
        console.log(`viewer for "${task}": ${viewer.url} (Ctrl+C to stop)`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  return program;
}
