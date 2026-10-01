import { Command, InvalidArgumentError } from "commander";

import {
  compileTask,
  formatCompileResult,
  formatWorkflow,
  loadWorkflow,
} from "hotpath-compiler";
import { runRecorder } from "hotpath-recorder";
import { runTask } from "hotpath-runtime";
import {
  addSchedule,
  computeStats,
  defaultStateDir,
  formatStats,
  loadBaselines,
  loadSchedules,
  nextRun,
  parseSince,
  readRuns,
  removeSchedule,
  runDueOnce,
  runtimeRunner,
  setScheduleEnabled,
  startDaemon,
  table,
} from "hotpath-scheduler";
import { startViewer } from "hotpath-viewer";
import path from "node:path";

import type { ClaudeScope } from "./wrap/agents.js";
import { repoRoot, selfCommand } from "./wrap/self.js";
import { unwrap, wrap, type WrapResult } from "./wrap/wrap.js";

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

  program
    .command("wrap")
    .description("Route an agent's MCP server through the recorder")
    .argument("<agent>", "openclaw or claude-code")
    .argument("<server>", "MCP server name in the agent's config")
    .requiredOption("--task <name>", "task name to record under")
    .option("--dry-run", "print the change without writing anything")
    .option("--config <path>", "agent config file (default: the agent's own)")
    .option(
      "--scope <scope>",
      "claude-code only: local, project or user",
      parseScope,
    )
    .action(
      async (
        agent: string,
        server: string,
        options: {
          task: string;
          dryRun?: boolean;
          config?: string;
          scope?: ClaudeScope;
        },
      ) => {
        await reportWrap(
          () =>
            wrap({ agent, server, ...options, stateDir, self: selfCommand() }),
          options.dryRun
            ? "dry run, nothing written"
            : `wrapped "${server}": ${agent} now records task "${options.task}"\n` +
                `undo with: hotpath unwrap ${agent} ${server}`,
        );
      },
    );

  program
    .command("unwrap")
    .description("Restore an MCP server that `hotpath wrap` changed")
    .argument("<agent>", "openclaw or claude-code")
    .argument("<server>", "MCP server name in the agent's config")
    .option("--dry-run", "print the change without writing anything")
    .option(
      "--config <path>",
      "agent config file (default: the one wrap edited)",
    )
    .action(
      async (
        agent: string,
        server: string,
        options: { dryRun?: boolean; config?: string },
      ) => {
        await reportWrap(
          () => unwrap({ agent, server, ...options, stateDir }),
          options.dryRun
            ? "dry run, nothing written"
            : `restored "${server}" in the ${agent} config`,
        );
      },
    );

  addScheduleCommands(program);
  addDaemonCommands(program);

  return program;
}

/** Print the error and exit 1: every scheduler command fails the same way. */
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parseFallback(value: string): "auto" | "notify" | "off" {
  if (value === "auto" || value === "notify" || value === "off") return value;
  throw new InvalidArgumentError("expected auto, notify or off");
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("expected a positive whole number");
  }
  return n;
}

function addScheduleCommands(program: Command): void {
  const schedule = program
    .command("schedule")
    .description("Run compiled workflows on a schedule (see `hotpath daemon`)");

  schedule
    .command("add")
    .description("Add a schedule for a compiled task")
    .argument("<task>", "task name (workflows/<task>.json must exist)")
    .requiredOption("--cron <expr>", 'cron expression, e.g. "0 7 * * 1-5"')
    .option("--tz <zone>", "IANA time zone (default: this computer's)")
    .option(
      "--input <key=value...>",
      "inputs; @today, @yesterday, @tomorrow, @now and @weekday resolve at run time",
      collectInputs,
      {} as Record<string, string>,
    )
    .option(
      "--allow-side-effects",
      "really run side-effect steps (default: dry-run them)",
    )
    .option(
      "--fallback <mode>",
      "on drift: auto (run the agent), notify (default) or off",
      parseFallback,
    )
    .action(
      (
        task: string,
        options: {
          cron: string;
          tz?: string;
          input: Record<string, string>;
          allowSideEffects?: boolean;
          fallback?: "auto" | "notify" | "off";
        },
      ) =>
        guarded(async () => {
          const s = await addSchedule(defaultStateDir, {
            task,
            cron: options.cron,
            timezone: options.tz,
            inputs: options.input,
            allowSideEffects: options.allowSideEffects,
            fallback: options.fallback,
          });
          const next = nextRun(s.cron, s.timezone, new Date());
          console.log(
            `added ${s.id}: ${s.task} at "${s.cron}" (${s.timezone}), next run ${next?.toISOString() ?? "never"}`,
          );
          if (s.sideEffects === "dry-run") {
            console.log(
              "side effects are dry-run: steps marked ⚡ are skipped until you add the schedule with --allow-side-effects",
            );
          }
          console.log("start the scheduler with: hotpath daemon");
        }),
    );

  schedule
    .command("list")
    .description("List schedules with their next run and last status")
    .action(() =>
      guarded(async () => {
        const schedules = await loadSchedules(defaultStateDir);
        if (schedules.length === 0) {
          console.log(
            'no schedules yet — add one with: hotpath schedule add <task> --cron "0 7 * * *"',
          );
          return;
        }
        const runs = await readRuns(defaultStateDir);
        const now = new Date();
        console.log(
          table(
            ["id", "task", "cron", "next run", "enabled", "last status"],
            schedules.map((s) => {
              const last = runs.filter((r) => r.scheduleId === s.id).at(-1);
              return [
                s.id,
                s.task,
                `${s.cron} (${s.timezone})`,
                s.enabled
                  ? (nextRun(s.cron, s.timezone, now)?.toISOString() ?? "never")
                  : "-",
                s.enabled ? "yes" : "no",
                last ? `${last.status} ${last.startedAt}` : "-",
              ];
            }),
          ),
        );
      }),
    );

  schedule
    .command("remove")
    .description("Remove a schedule")
    .argument("<id>", "schedule id (see hotpath schedule list)")
    .action((id: string) =>
      guarded(async () => {
        await removeSchedule(defaultStateDir, id);
        console.log(`removed ${id}`);
      }),
    );

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    schedule
      .command(name)
      .description(`${enabled ? "Enable" : "Disable"} a schedule`)
      .argument("<id>", "schedule id (see hotpath schedule list)")
      .action((id: string) =>
        guarded(async () => {
          await setScheduleEnabled(defaultStateDir, id, enabled);
          console.log(`${name}d ${id}`);
        }),
      );
  }

  program
    .command("runs")
    .description("Show recent scheduled runs")
    .option("--task <name>", "only this task")
    .option("--limit <n>", "how many", parsePositiveInt, 20)
    .action((options: { task?: string; limit: number }) =>
      guarded(async () => {
        const runs = await readRuns(defaultStateDir, options);
        if (runs.length === 0) {
          console.log("no runs yet");
          return;
        }
        console.log(
          table(
            ["started", "task", "status", "time", "llm", "cost", "note"],
            runs
              .slice()
              .reverse()
              .map((r) => [
                r.startedAt,
                r.task,
                r.status,
                `${(r.durationMs / 1000).toFixed(1)}s`,
                String(r.llmCalls),
                `$${r.costUsd.toFixed(4)}`,
                [
                  r.sideEffectsMode === "dry-run" ? "dry-run" : "",
                  r.fallback ? "agent fallback" : "",
                  r.error ?? "",
                ]
                  .filter(Boolean)
                  .join("; ")
                  .slice(0, 80),
              ]),
          ),
        );
      }),
    );

  program
    .command("stats")
    .description("Runs, success rate, cost and estimated savings per task")
    .option("--since <window>", "time window: 90m, 12h, 30d, 2w", "30d")
    .action((options: { since: string }) =>
      guarded(async () => {
        const since = parseSince(options.since, new Date());
        const runs = await readRuns(defaultStateDir, { since });
        const tasks = [...new Set(runs.map((r) => r.task))];
        const stats = computeStats(runs, await loadBaselines(tasks));
        console.log(formatStats(stats, options.since));
      }),
    );
}

function addDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Run due schedules in the foreground (Ctrl+C to stop)")
    .action(() =>
      guarded(async () => {
        const handle = await startDaemon({
          stateDir: defaultStateDir,
          runner: runtimeRunner,
        });
        let signals = 0;
        const onSignal = () => {
          signals++;
          if (signals > 1) process.exit(130); // second Ctrl+C: don't wait
          console.log("stopping… (Ctrl+C again to force)");
          void handle.stop();
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        await handle.done;
        process.exit(0);
      }),
    );
  void daemon;

  program
    .command("run-due")
    .description(
      "Run the schedules that are due now, then exit (for OS schedulers and CI)",
    )
    .requiredOption("--once", "run once and exit (the only mode)")
    .action(() =>
      guarded(() =>
        runDueOnce({ stateDir: defaultStateDir, runner: runtimeRunner }),
      ),
    );
}

const stateDir = path.join(repoRoot, ".hotpath");

function parseScope(value: string): ClaudeScope {
  if (value === "local" || value === "project" || value === "user")
    return value;
  throw new InvalidArgumentError("expected local, project or user");
}

async function reportWrap(
  run: () => Promise<WrapResult>,
  done: string,
): Promise<void> {
  try {
    const result = await run();
    console.log(`${result.file}\n${result.diff}\n\n${done}`);
    if (result.changed) console.log(result.reloadHint);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
