# Run tasks on a schedule

```bash
hp schedule add morning-brief --cron "0 7 * * 1-5" --tz Europe/Paris --input date=@today
hp daemon                 # runs due schedules; Ctrl+C to stop
hp daemon install         # optional: start it at login
hp stats                  # what it cost and roughly what it saved
```

(`hp` is the Hotpath CLI; see [INTEGRATIONS.md](INTEGRATIONS.md) for the one-line
alias.)

## Safe by default

- **Side effects are dry-run** until you ask for them. Steps marked ⚡ (sending a
  message, writing a file) are skipped and printed. Add the schedule with
  `--allow-side-effects` when you trust the workflow.
- **No surprise agent costs.** On drift, the default `--fallback notify` records the run
  as `drift` and notifies you; the agent is not started. `--fallback auto` lets Hotpath
  run the agent and recompile (as `hotpath run` does); `--fallback off` just marks the
  run `failed`. With side effects in dry-run, the agent never runs either.

## Commands

| Command                                  | What it does                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `hp schedule add <task> --cron "<expr>"` | Add a schedule. `--tz`, `--input k=v`, `--allow-side-effects`, `--fallback` |
| `hp schedule list`                       | Schedules, next run, enabled, last status                                   |
| `hp schedule remove/enable/disable <id>` | Manage one schedule                                                         |
| `hp daemon`                              | Foreground scheduler (one per project)                                      |
| `hp run-due --once`                      | Run what's due now and exit (for cron, Task Scheduler, CI)                  |
| `hp runs [--task X] [--limit 20]`        | Recent runs                                                                 |
| `hp stats [--since 30d]`                 | Runs, success rate, cost, estimated savings per task                        |
| `hp daemon install/uninstall/status`     | Start the daemon at login (Task Scheduler, launchd, systemd)                |

## Dynamic inputs

Values starting with `@` are resolved when the run starts, in the schedule's time zone:
`@today`, `@yesterday`, `@tomorrow` (YYYY-MM-DD), `@now` (ISO timestamp), `@weekday`
(monday…sunday). Anything else is passed as written.

## How the daemon behaves

- Edits to `.hotpath/schedules.json` (including from `hp schedule …`) are picked up
  without a restart.
- A schedule never overlaps itself: if the previous run is still going, the new slot is
  skipped and logged.
- If the daemon was stopped, it catches up at most one missed run per schedule, and only
  if that slot is less than an hour old.
- Ctrl+C lets the current run finish, writes the history and releases the lock. Press it
  twice to stop immediately.

## Notifications

Create `.hotpath/config.json`:

```json
{
  "notify": { "desktop": true, "webhook": "https://hooks.example.com/hotpath" }
}
```

You get a notification for `drift` and `failed` runs (never for successful ones) with
the task, the reason and the command to inspect it. The webhook receives a JSON POST
(`task`, `status`, `reason`, `scheduleId`, `startedAt`, `inspect`) with a 5 s timeout and
at most one retry. Notifications never contain tool results.

## Savings estimates

`hp stats` compares each successful run with the agent run the workflow was compiled
from: its wall time, and its cost when the agent reported one. Without that baseline
the columns say `n/a`. These are estimates, not invoices.

## Files

Everything is plain files in `.hotpath/` (gitignored): `schedules.json`, `runs.jsonl`,
`config.json`, `daemon.lock`, `scheduler-state.json`, `daemon.log` (macOS) and
`wrap-backups/`.
