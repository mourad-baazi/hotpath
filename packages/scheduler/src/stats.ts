import type { RunRecord, Workflow } from "hotpath-shared";

export type Baseline = Workflow["baseline"];

export interface TaskStats {
  task: string;
  /** runs that actually ran (skipped ones are counted separately) */
  runs: number;
  ok: number;
  skipped: number;
  /** ok / runs, 0..1; null when nothing ran */
  successRate: number | null;
  /** what the workflow runs cost in total */
  workflowCostUsd: number;
  /** estimate: (agent baseline − workflow) over the ok runs; null when unknown */
  estCostSavedUsd: number | null;
  estTimeSavedMs: number | null;
}

/**
 * Per-task stats. "Saved" numbers compare each successful run with the agent
 * run the workflow was compiled from; without a baseline they are null and
 * shown as "n/a" — never invented.
 */
export function computeStats(
  runs: RunRecord[],
  baselines: Map<string, Baseline>,
): TaskStats[] {
  const byTask = new Map<string, RunRecord[]>();
  for (const run of runs) {
    byTask.set(run.task, [...(byTask.get(run.task) ?? []), run]);
  }
  return [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, list]) => {
      const ran = list.filter((r) => r.status !== "skipped");
      const ok = ran.filter((r) => r.status === "ok");
      const baseline = baselines.get(task);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      return {
        task,
        runs: ran.length,
        ok: ok.length,
        skipped: list.length - ran.length,
        successRate: ran.length > 0 ? ok.length / ran.length : null,
        workflowCostUsd: sum(ran.map((r) => r.costUsd)),
        estCostSavedUsd:
          baseline?.costUsd !== undefined && ok.length > 0
            ? sum(ok.map((r) => baseline.costUsd! - r.costUsd))
            : null,
        estTimeSavedMs:
          baseline && ok.length > 0
            ? sum(ok.map((r) => baseline.durationMs - r.durationMs))
            : null,
      };
    });
}

function usd(value: number): string {
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 4 : 2)}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return Math.abs(m) < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

export function formatStats(stats: TaskStats[], sinceLabel: string): string {
  if (stats.length === 0) return `no runs in the last ${sinceLabel}`;
  const rows = stats.map((s) => [
    s.task,
    String(s.runs),
    s.successRate === null ? "n/a" : `${Math.round(s.successRate * 100)}%`,
    usd(s.workflowCostUsd),
    s.estCostSavedUsd === null ? "n/a" : `~${usd(s.estCostSavedUsd)}`,
    s.estTimeSavedMs === null ? "n/a" : `~${duration(s.estTimeSavedMs)}`,
  ]);
  return (
    table(
      [
        "task",
        "runs",
        "success",
        "workflow cost",
        "est. cost saved",
        "est. time saved",
      ],
      rows,
    ) +
    `\n\nlast ${sinceLabel}. "est." = estimate vs. the agent run each workflow was compiled from; ` +
    "n/a = no agent baseline recorded."
  );
}

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
