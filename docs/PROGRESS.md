# Progress

Tick a milestone only when all its acceptance checks in SPEC.md pass.

- [x] M1 — Scaffold — pnpm workspaces monorepo, strict TS/ESM, eslint+prettier, commander CLI with record/compile/show/run/view placeholders, vitest green (`pnpm install && pnpm -r build && pnpm -r test && pnpm lint && pnpm hotpath --help` all pass).
- [x] M2 — Fake MCP tools server — stdio MCP server (get_emails/get_calendar/get_weather/send_message) with default/new-data/drift fixtures, expected.json per set, send_message writes out/messages.json; 6 vitest tests via MCP SDK client all green.
- [x] M3 — Recorder — `hotpath record` MCP stdio proxy (server→agent, client→spawned server) writing validated JSONL traces (meta/tools/inputs, tool_call lines, end on disconnect/SIGTERM); results forwarded unchanged; 3 vitest tests green.
- [x] M4 — Demo agent — tool-use loop through the recorder proxy, metrics to out/agent-run.json; mocked-llm test green; manual real run on Groq (openai/gpt-oss-120b): 4 tool calls, 3.7s, every mustMention in out/messages.json.
- [x] M5 — Compiler — deterministic trace→workflow compiler (7 rules), full workflow zod schema + §5.2 template engine in shared, `hotpath compile`/`hotpath show` wired; 6 compiler tests on checked-in fixture + 4 template tests green.
- [x] M6 — Runtime — `hotpath run <task> [--input k=v] [--dry-run] [--no-fallback]`: spawns the workflow server, executes steps with templates, llm steps via mocked-in-tests llm.ts, writes out/hotpath-run.json + one-line summary; missing-input error lists examples; 3 runtime tests green (manual real run on Groq gpt-oss-20b: 1.5s, $0.002, all mustMention present).
- [x] M7 — Guards, fallback, recompile — ajv schema + llm guards after every step; drift prints `⚠ drift at <step>: <reason>`, runs the configured agent once, backs up + recompiles the workflow, sets fallback/driftStep/reason in out/hotpath-run.json; never falls back after a side effect ran, with --no-fallback or --dry-run (non-zero exit). Also fixed M5: llm prompts now use {{steps.*.result}} templates, not baked-in data. 8 runtime tests green.
- [x] M8 — Benchmark — `pnpm bench` (real Groq calls): same-data, new-data, drift→fallback→recompile→clean rerun all ✅, table + bench/results.json, `--skip-agent`; pure helpers unit-tested (7 tests).
- [x] M9 — Viewer — `hotpath view <task>` starts a Vite + React Flow page (tool=grey, llm=highlighted, ⚡ side effects, edges from template refs, "N steps · M use AI" header, step side panel); workflow→graph conversion unit-tested (5 tests); checked manually in the browser.
