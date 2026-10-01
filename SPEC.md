# Hotpath — MVP Spec

## 1. What we are building

AI agents (OpenClaw, Claude Code, custom agents) redo the same recurring tasks from
scratch every time — a morning brief, inbox triage, a weekly report — paying frontier-model
prices on every run and producing slightly different results.

**Hotpath records an agent doing a task once and compiles it into a workflow:**

```
agent does task once ──► recorder captures every tool call ──► trace
trace ──► compiler ──► workflow (tool steps = plain code, llm steps = only where judgment is needed)
workflow ──► runtime runs it: fast, cheap, same shape every time
guard fails (drift) ──► fall back to the agent ──► new trace ──► recompile
```

**MVP goal:** prove the loop end-to-end on a fake "morning brief" task, with a benchmark
table showing the workflow matches the agent's behavior at a fraction of the time and cost,
generalizes to new data, and self-heals on drift (§7).

## 2. Glossary

| Term | Meaning |
|---|---|
| **Task** | A named recurring job, e.g. `morning-brief`. |
| **Trace** | JSONL log of one agent run: every MCP tool call with args, result, timing. |
| **Workflow** | JSON file compiled from a trace: ordered steps + inputs + guards. |
| **Tool step** | Calls an MCP tool with templated args. No LLM. |
| **LLM step** | Generates text (e.g. a summary) with the cheap model. The only non-deterministic part. |
| **Input** | A value that changes between runs (e.g. `date`). |
| **Guard** | A check on a step's output (JSON schema, non-empty, max length). Failure = drift. |
| **Fallback** | On drift: run the real agent, record a new trace, recompile. |

## 3. Repo layout

```
hotpath/
  AGENTS.md  SPEC.md  PROGRESS.md  README.md
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .env.example  .gitignore
  hotpath.config.json          # task → agent/server commands (see §4)
  packages/
    shared/     # zod schemas (trace, workflow), llm.ts, pricing.ts, template.ts, paths
    recorder/   # MCP stdio proxy + trace writer
    compiler/   # trace → workflow
    runtime/    # workflow executor, guards, fallback
    cli/        # `hotpath` command (commander)
    viewer/     # Vite + React Flow graph viewer (milestone 9)
  examples/
    demo-tools/ # fake MCP server + fixtures/{default,new-data,drift}/
    demo-agent/ # small Kimi-powered agent that does the morning brief
  bench/        # benchmark script (milestone 8)
  traces/ workflows/ out/      # generated, gitignored
```

## 4. Configuration

`.env` (copy from `.env.example`; never commit):

```
MOONSHOT_API_KEY=            # required for demo-agent and bench only
MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
HOTPATH_AGENT_MODEL=kimi-k3          # the "expensive agent" model
HOTPATH_CHEAP_MODEL=kimi-k2.7-code   # used by workflow llm steps
# Prices in USD per 1M tokens (verify current prices on platform.kimi.ai)
PRICE_AGENT_IN=3
PRICE_AGENT_OUT=15
PRICE_CHEAP_IN=0.95
PRICE_CHEAP_OUT=4
```

Model names and prices change; check platform.kimi.ai and update `.env` if a call 404s.

`hotpath.config.json`:

```json
{
  "tasks": {
    "morning-brief": {
      "agent": "pnpm --filter demo-agent start --",
      "server": "pnpm --silent --filter demo-tools start"
    }
  }
}
```

- `server` = command that starts the real MCP server (stdio).
- `agent` = command that runs the agent for this task; Hotpath appends
  `--task <name> --date <date>` when it needs a fallback run.
- The environment (including `DEMO_FIXTURES`) is inherited by every spawned process.

## 5. Data formats

All formats are defined as zod schemas in `packages/shared/src/schemas.ts` and exported
as TS types. Files must validate against them on read and write.

### 5.1 Trace — `traces/<task>/<ISO-timestamp>.jsonl`

One JSON object per line. First line is `meta`, last line is `end`.

```jsonc
{"type":"meta","version":1,"task":"morning-brief","startedAt":"2026-10-01T07:00:00.000Z",
 "server":"pnpm --silent --filter demo-tools start","inputs":{"date":"2026-10-01"},
 "tools":[{"name":"get_emails","inputSchema":{...},"annotations":{"readOnlyHint":true}}, ...]}
{"type":"tool_call","seq":1,"tool":"get_emails","args":{"date":"2026-10-01"},
 "result":{...},"isError":false,"startedAt":"...","durationMs":12}
{"type":"end","endedAt":"...","toolCalls":4}
```

- `result` is the MCP tool result's structured content if present, else the parsed JSON
  of its first text content, else the raw text.
- `inputs` come from the agent (demo-agent passes `--date`; the recorder reads them from
  the `HOTPATH_INPUTS` env var as JSON, e.g. `{"date":"2026-10-01"}`).

### 5.2 Workflow — `workflows/<task>.json`

```jsonc
{
  "version": 1,
  "task": "morning-brief",
  "compiledFrom": "traces/morning-brief/2026-10-01T07-00-00-000Z.jsonl",
  "server": "pnpm --silent --filter demo-tools start",
  "inputs": { "date": { "type": "string", "example": "2026-10-01" } },
  "steps": [
    { "id": "s1", "type": "tool", "tool": "get_emails",
      "args": { "date": "{{inputs.date}}" },
      "sideEffect": false,
      "guard": { "schema": { /* JSON schema inferred from the recorded result */ } } },
    { "id": "s4", "type": "llm", "model": "cheap",
      "prompt": "…instruction…\n\nEmails:\n{{steps.s1.result}}\n…",
      "example": "…the text the agent produced in the trace…",
      "guard": { "nonEmpty": true, "maxChars": 3000 } },
    { "id": "s5", "type": "tool", "tool": "send_message",
      "args": { "to": "me", "text": "{{steps.s4.output}}" },
      "sideEffect": true, "guard": {} }
  ]
}
```

Template syntax (implemented once in `packages/shared/src/template.ts`):
`{{inputs.<name>}}`, `{{steps.<id>.result}}` (whole result, JSON-stringified when inside
a longer string), `{{steps.<id>.result.<json.path>}}` (e.g. `items.0.id`),
`{{steps.<id>.output}}` (llm step text). A value that is *exactly* one template keeps
its original type; otherwise it's string interpolation.

## 6. Milestones

Each milestone lists **acceptance checks**. Turn them into vitest tests first (where they
are automatable), then implement. All checks must pass before moving on.

### M1 — Scaffold
Create the monorepo from §3 (empty packages with `src/index.ts`), strict TS, vitest,
eslint + prettier, `.gitignore`, `.env.example`, `hotpath.config.json`, and a `hotpath`
CLI (commander) with placeholder commands `record`, `compile`, `show`, `run`, `view`.
Root scripts: `build`, `test`, `lint`, `hotpath` (runs the CLI via tsx), `bench`.

**Acceptance:**
- `pnpm install && pnpm -r build && pnpm -r test && pnpm lint` all pass.
- `pnpm hotpath --help` lists the five commands.

### M2 — Fake MCP tools server (`examples/demo-tools`)
A stdio MCP server exposing:

| Tool | Args | Returns | Annotations |
|---|---|---|---|
| `get_emails` | `{ date: string }` | `{ emails: [{ id, from, subject, snippet }] }` | readOnlyHint: true |
| `get_calendar` | `{ date: string }` | `{ events: [{ time, title, location }] }` | readOnlyHint: true |
| `get_weather` | `{ city: string, date: string }` | `{ city, date, summary, highC, lowC }` | readOnlyHint: true |
| `send_message` | `{ to: string, text: string }` | `{ ok: true, id }` | readOnlyHint: false, destructiveHint: false |

- Data comes from `fixtures/<DEMO_FIXTURES>/` (`emails.json`, `calendar.json`,
  `weather.json`), default fixture set = `default`. Return structured content.
- `send_message` appends `{ to, text, at }` to `out/messages.json` (repo-root `out/`).
- Fixture sets:
  - `default`: date `2026-10-01`, 3 emails, 2 events, weather for Paris.
  - `new-data`: date `2026-10-02`, *different* 3 emails / 2 events / weather.
  - `drift`: same as `default` but every email uses `title` instead of `subject`
    (simulates an API change).
- Each fixture set has `expected.json`: `{ "date": "...", "mustMention": [...] }` — 4–6
  distinctive strings (an email subject, an event title, the weather summary word) a
  correct brief must contain.

**Acceptance:**
- Tests spin the server up with the MCP SDK client: `tools/list` returns 4 tools with the
  annotations above; each tool returns fixture data; `send_message` writes the file.
- Switching `DEMO_FIXTURES=new-data` returns the new data.
- Manual: `npx @modelcontextprotocol/inspector pnpm --silent --filter demo-tools start`
  shows the tools.

### M3 — Recorder (`packages/recorder`, `hotpath record`)
`hotpath record --task <name> -- <server command…>`

- Acts as an MCP **server** on stdio towards the agent and as an MCP **client** towards
  the real server it spawns.
- Forwards `tools/list` and `tools/call` unchanged (results must be byte-identical to
  calling the server directly).
- Writes the trace (§5.1) to `traces/<task>/<timestamp>.jsonl`: `meta` on start (after
  the first `tools/list`), one `tool_call` per call, `end` on shutdown (stdin close/SIGTERM).
- Never writes anything except MCP protocol messages to stdout (logs go to stderr).

**Acceptance:**
- Test: an MCP client connects to `hotpath record --task t -- <demo-tools>`, lists
  tools, calls 3 tools, disconnects → trace file exists, validates against the schema,
  contains `meta`, 3 `tool_call` lines in order with correct args/results, and `end`.
- Test: results via the proxy deep-equal results from demo-tools directly.
- Test: tool errors are forwarded and recorded with `isError: true`.

### M4 — Demo agent (`examples/demo-agent`)
`pnpm --filter demo-agent start -- --task morning-brief --date 2026-10-01`

- Uses `packages/shared/src/llm.ts` (OpenAI SDK → Moonshot) with `HOTPATH_AGENT_MODEL`.
- Connects to MCP by spawning `hotpath record --task <task> -- <server from config>` with
  `HOTPATH_INPUTS={"date":…}` in its env.
- Converts MCP tools to OpenAI function-tools; standard tool-use loop (max 12 turns).
- System prompt: *"You are a personal assistant. Today is {date}. Produce the user's
  morning brief: read today's emails, calendar and the weather in Paris, then call
  send_message with to="me" and a concise brief that mentions every email subject,
  every event and the weather."*
- Writes metrics to `out/agent-run.json`:
  `{ durationMs, llmCalls, promptTokens, completionTokens, costUsd }`
  (cost from `pricing.ts` using the agent prices).

**Acceptance:**
- Unit test with a mocked `llm.ts` that scripts tool calls: the loop executes them and
  stops; metrics file is written.
- Manual (real API): running the command creates a trace with ~4 tool calls, a brief in
  `out/messages.json` containing every `mustMention` string, and prints the cost.

### M5 — Compiler (`packages/compiler`, `hotpath compile`, `hotpath show`)
`hotpath compile <task> [--trace <file>]` (default: latest trace) → `workflows/<task>.json`.
The compiler is **deterministic and needs no API key** in the MVP.

Rules, in order:
1. Each `tool_call` becomes a `tool` step (`id` = `s<seq>`), in the same order.
2. **Inputs:** any arg value equal to a trace `meta.inputs` value becomes
   `{{inputs.<name>}}`.
3. **Data flow:** any arg value equal to a value found in an earlier step's result becomes
   `{{steps.<id>.result.<path>}}`.
4. **Generated text:** any remaining string arg that is ≥ 40 chars or contains a newline
   was written by the LLM → insert an `llm` step just before that tool step, whose
   `prompt` = the task instruction + the JSON results of all earlier read-only steps
   (as templates) + "write the `<arg>` for `<tool>`", with `example` = the recorded text;
   replace the arg with `{{steps.<llmId>.output}}`.
5. Everything else stays a constant (e.g. `city: "Paris"`, `to: "me"`).
6. `sideEffect` = `!annotations.readOnlyHint`.
7. **Guards:** tool steps get a JSON schema inferred from the recorded result (object
   keys observed = `required`, primitive types, array item schema from the first item);
   llm steps get `{ nonEmpty: true, maxChars: max(3 × example length, 500) }`.

`hotpath show <task>` prints the steps as a readable list, e.g.
`s1 tool get_emails(date={{inputs.date}})` / `s4 llm (cheap) → s5.text`.

**Acceptance:**
- Tests on a **checked-in fixture trace** (`packages/compiler/test/fixtures/`):
  output validates against the workflow schema; `date` args are templated as inputs;
  `city`/`to` stay constant; exactly one `llm` step, feeding `send_message.text`;
  `send_message` has `sideEffect: true`; `get_emails` guard requires `subject`.
- Compiling the same trace twice produces identical output (deterministic).

### M6 — Runtime (`packages/runtime`, `hotpath run`)
`hotpath run <task> [--input key=value …] [--dry-run] [--no-fallback]`

- Spawns the workflow's `server`, connects as an MCP client, executes steps in order,
  resolving templates.
- `llm` steps call `llm.ts` with `HOTPATH_CHEAP_MODEL`, prompt + "Match the style and
  length of this example: <example>".
- `--dry-run`: skip `sideEffect` steps and print what they would have sent.
- Writes `out/hotpath-run.json`:
  `{ durationMs, llmCalls, promptTokens, completionTokens, costUsd, fallback: false, steps: [{ id, durationMs, ok }] }`
  and prints a one-line summary: `✓ morning-brief in 0.6s, $0.0021 (1 llm call)`.
- Missing required input → clear error listing the inputs and their examples.

**Acceptance:**
- Tests with a mocked `llm.ts` against demo-tools: the tool-call sequence (names + args)
  equals the trace's for the same date; `out/messages.json` gets the mocked text;
  `--dry-run` writes nothing to `out/messages.json`.
- Manual (real API): `hotpath run morning-brief --input date=2026-10-01` produces a brief
  containing every `mustMention` string, much faster and cheaper than the agent run.

### M7 — Guards, fallback, recompile
- After each step, check its guard (ajv for schemas). On failure, stop and:
  1. print `⚠ drift at <step>: <reason>`;
  2. unless `--no-fallback`, run the task's `agent` command (from config) with
     `--task <task> --date <inputs.date>` — this records a fresh trace;
  3. recompile the workflow from the new trace (keep the old one as
     `workflows/<task>.<timestamp>.bak.json`);
  4. set `fallback: true` (+ `driftStep`, `reason`) in `out/hotpath-run.json`.
- Side-effect steps must not have run before the failing guard (they come later in the
  morning-brief flow; for safety, in general, a guard failure *before* any side effect
  must never trigger that side effect twice).

**Acceptance:**
- Test (mocked agent command + mocked llm): with `DEMO_FIXTURES=drift`, `hotpath run`
  reports drift at `s1` (missing `subject`), invokes the agent command once, recompiles,
  and the new workflow's `get_emails` guard requires `title`.
- Test: `--no-fallback` exits with a non-zero code and does not call the agent.
- Test: a subsequent run on `drift` fixtures passes with `fallback: false`.

### M8 — Benchmark (`bench/`, `pnpm bench`)
See §7. This is the "does it actually work" proof.

### M9 — Viewer (`packages/viewer`, `hotpath view`)
`hotpath view <task>` starts a local Vite server and opens a page rendering the workflow
with React Flow: one node per step (tool = grey, llm = highlighted, side effect = marked),
edges from template references, a header with "N steps · M use AI", and a side panel
showing the selected step's args/prompt/guard.

**Acceptance:** page loads on localhost and shows the morning-brief graph with correct
edges (manual check + a unit test for the workflow → nodes/edges conversion).

## 7. Test workflow — `pnpm bench`

The benchmark runs real API calls (needs `MOONSHOT_API_KEY`) and proves the MVP:

1. **Setup** — `DEMO_FIXTURES=default`: clear `out/`, run the agent for `2026-10-01`
   (records a trace), then `hotpath compile morning-brief`.
2. **same-data** — run `hotpath run morning-brief --input date=2026-10-01`.
   Pass if: tool-call sequence (names + args, ignoring the llm-written text) matches the
   trace, brief contains all `mustMention`, `fallback: false`.
3. **new-data** — `DEMO_FIXTURES=new-data`: run the agent for `2026-10-02` (for the
   cost/time comparison only — do **not** recompile from this trace), then
   `hotpath run … --input date=2026-10-02`.
   Pass if: brief contains all new `mustMention`, `fallback: false` (proves it
   generalizes without the agent).
4. **drift** — `DEMO_FIXTURES=drift`: `hotpath run … --input date=2026-10-01`.
   Pass if: drift detected at `s1` → fallback ran → recompiled → a second `hotpath run`
   passes with `fallback: false` and all `mustMention`.

Output: a table like below, plus `bench/results.json`. Exit code 1 if any scenario fails.
Flag `--skip-agent` skips the comparison agent run in step 3 to save money.

```
scenario    agent time / cost    hotpath time / cost    speedup  cheaper  match  fallback
same-data   38.2s / $0.0410      0.6s / $0.0021          64x      20x     ✅     no
new-data    41.0s / $0.0440      0.7s / $0.0022          59x      20x     ✅     no
drift       -                    44.1s / $0.0452 → 0.6s  -        -       ✅     yes → recompiled
```

When all three pass, the MVP is done — this table is the first demo.

## 8. Out of scope for the MVP

Browser/UI automation, a cloud service, auth/multi-user, branching/looping workflows
(steps are a straight line), LLM-assisted compilation, OpenClaw integration (next phase),
Windows-specific support.

## 9. After the MVP (next phases, do not build yet)

1. **OpenClaw plugin** — record real OpenClaw tasks through the MCP proxy; demo video.
2. **Claude Code / Hermes / LangGraph recorders.**
3. **LLM-assisted compiler** (`--refine`): better prompts, loops over lists, branching.
4. **Hotpath Hub** — share compiled workflows as templates.
5. **Cloud** — hosted runs, schedules, drift alerts, team libraries.
