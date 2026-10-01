# Benchmark

`pnpm bench` runs the end-to-end loop against a real LLM for each demo task and checks
that the compiled workflow matches the agent's behavior, generalizes to new data and
recovers from drift. This page holds the full results, how to read them, and the
limitations of the measurements.

## Setup

- **Date:** 2026-10-01
- **Code:** commit `f914cb4` for the table below (grounding guard, recompile safety check
  and honest timings included); the second run in the pass-rate table used `87dd5f0`,
  which only adds the rate-limit wait cap and setup-failure handling to the bench
- **Provider:** Groq (OpenAI-compatible API)
- **Agent model:** `qwen/qwen3.8-27b`
- **Cheap model (workflow `llm` steps):** `openai/gpt-oss-20b` with
  `HOTPATH_CHEAP_REASONING=low`
- **Tasks:** `morning-brief` (4 tool calls, 1 LLM step) and `weekly-report` (13 tool
  calls, 2 LLM steps, data passed between steps)

The agent model was changed from `openai/gpt-oss-120b` to `qwen/qwen3.8-27b` because the
account's daily token limit for the former was exhausted before the benchmark finished.

## Results

Output of one complete run, unedited:

```
scenario                 agent time / cost                        hotpath time / cost                             startup + tools + llm  speedup  cheaper  match  fallback
morning-brief/same-data  3.7s / $0.0206                           0.9s / $0.0021                                  224ms + 37ms + 612ms   4x       10x      ✅      no
morning-brief/new-data   3.3s / $0.0175 (+15.0s rate-limit wait)  1.0s / $0.0018                                  241ms + 37ms + 746ms   3x       10x      ✅      no
morning-brief/drift      -                                        4.4s / $0.0175 (+28.0s rate-limit wait) → 0.7s  216ms + 39ms + 416ms   -        -        ✅      yes → recompiled
weekly-report/same-data  6.7s / $0.0503 (+61.0s rate-limit wait)  1.6s / $0.0039                                  219ms + 54ms + 1.3s    4x       13x      ✅      no
weekly-report/new-data   6.7s / $0.0438 (+74.0s rate-limit wait)  1.3s / $0.0038                                  216ms + 54ms + 986ms   5x       12x      ✅      no
weekly-report/drift      -                                        7.6s / $0.0499 (+54.0s rate-limit wait) → 1.1s  222ms + 55ms + 781ms   -        -        ✅      yes → recompiled
```

## Scenarios

| Scenario      | What it checks                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **same-data** | The workflow, run on the data it was recorded on, makes the same tool calls as the recorded trace (ignoring LLM-written text), mentions every expected item, and does not fall back.                                                                                                  |
| **new-data**  | The same workflow on different data (other emails, other repositories and incident) mentions every expected item with no agent involved and no recompilation. The agent also runs once on this data, only to provide a time and cost comparison.                                      |
| **drift**     | A field is renamed in the tool output (`subject` → `title` for morning-brief, repository `name` → `slug` for weekly-report). The guard must catch it at step `s1`, the agent runs once, the workflow is recompiled, and a second run passes with no fallback and every expected item. |

Expected items are listed per fixture set in `examples/demo-tools/fixtures/`
(`expected.json`, `weekly-report.expected.json`). Matching ignores case and folds
typographic variants (non-breaking hyphens, curly quotes, narrow spaces); a missing item
still fails the scenario.

## Reading the table

- **agent time / cost** — the comparison agent run (setup run for same-data, a run on the
  new data for new-data). Not shown for drift, where the fallback run is the comparison.
- **hotpath time / cost** — the workflow run. For drift, the first figure is the fallback
  run including the agent, and the time after the arrow is the following clean run.
- **startup + tools + llm** — where the workflow's time goes: starting and connecting to
  the MCP server, all deterministic tool steps together, and the LLM steps. For drift it
  shows the clean run.
- **(+N s rate-limit wait)** — time spent sleeping between retries after the provider
  answered HTTP 429. It is measured by the client (`rateLimitWaitMs`), included in the
  wall-clock duration, and **excluded from the time shown** next to it.
- **speedup** — agent time ÷ hotpath time, both without rate-limit waits.
- **cheaper** — agent cost ÷ hotpath cost.
- **match** — the scenario's checks all passed.

## Notes and limitations

### Rate-limit waiting

The provider's free tier limits tokens per minute. When a limit is hit the client waits
and retries; that waiting is real elapsed time but says nothing about the model or the
workflow, so it is reported separately. In this run it reached 74 s on a single agent
run. Without it, the agent took about 3–4 s for `morning-brief` and about 6.7 s for
`weekly-report`, and the workflow is roughly 3–5x faster. Figures that included the
waiting (as in earlier runs) overstated the speedup, in some cases by an order of
magnitude.

A retry-after of more than about 65 s is treated as a quota (for example a daily token
limit) and fails immediately instead of waiting.

### Where the workflow's time goes

Starting and connecting to the MCP server takes about 220 ms. The deterministic tool
steps take 37–55 ms in total for 4 and 13 tool calls respectively. The remaining time is
the cheap model's response. With the model call being the only part that varies, speedups
depend mostly on how fast the agent model is on the provider used.

### Costs

Costs are computed from the per-token prices configured in `.env` (`PRICE_*`), not from
the provider's invoice. The run used the defaults from `.env.example` (agent $3 / $15,
cheap $0.95 / $4 per million input / output tokens), which are placeholders and not the
provider's actual prices. The "cheaper" ratio is therefore only as meaningful as those
prices.

### Sample size and nondeterminism

Each figure is a single run on small fake tasks. The LLM parts are not deterministic, so
individual scenarios have occasionally failed in development when the cheap model left an
item out of its output. The grounding guard was added to catch this: the compiler records
which values from earlier results the example output mentions, and at run time the output
must mention what the same fields hold now. If items are missing, the step is retried
once with the missing items listed, and if they are still missing the guard fails.

## Pass rates

`pnpm bench --runs N` repeats the whole benchmark N times and prints per-scenario pass
rates. Two complete runs were possible on the final code, with the same models on the
same day:

| Scenario                | Passed |
| ----------------------- | ------ |
| morning-brief/same-data | 2/2    |
| morning-brief/new-data  | 2/2    |
| morning-brief/drift     | 2/2    |
| weekly-report/same-data | 2/2    |
| weekly-report/new-data  | 2/2    |
| weekly-report/drift     | 1/1    |

This is a very small sample and not a statistical result. A third run was intended but
could not be completed:

- In the second run, the `weekly-report/drift` agent call was refused by the provider's
  daily token limit (200,000 tokens per day on the account used). A full benchmark spends
  roughly 85,000 agent tokens, so the limit ended the series. That scenario is excluded
  (1/1) and counted as neither a pass nor a failure.
- Earlier runs on the same day used code from before the grounding guard and the
  recompile check, and some missed an item in the output. They are not included.
- Runs that failed during setup because of the token limit are infrastructure failures
  and are not reported as pass rates.

To produce pass rates, run `pnpm bench --runs 3` with an agent model that is not rate
limited, or after the limit resets. `--skip-agent-reruns` skips the comparison agent run
in runs 2..N to save tokens, and `--task <name>` runs a single task. Results, including
per-run details, are written to `bench/results.json`.

## Reproducing

```bash
pnpm install
pnpm -r build
cp .env.example .env   # set LLM_API_KEY, LLM_BASE_URL and the model names
pnpm bench             # both tasks; add --runs 3 for pass rates
```

A full run makes real API calls and takes a few minutes; agent runs dominate the time and
the token use.
