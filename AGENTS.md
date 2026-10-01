# AGENTS.md — instructions for the coding agent

You are building **Hotpath**: a "JIT compiler" for AI agents. It records an agent's
tool calls while it does a task once, compiles that trace into a deterministic,
editable workflow, and re-runs the workflow with an LLM only at the steps that need
judgment. If a step's output no longer looks right (drift), it falls back to the
agent, records a new trace and recompiles.

The full product and technical spec is in **`docs/SPEC.md`**. Read it before starting any work.

## How to work

1. **One milestone at a time.** Milestones are in `docs/SPEC.md` §6. Do not start milestone
   N+1 until every acceptance check of milestone N passes. When you finish a milestone,
   tick it in `docs/PROGRESS.md` (create it if missing) with a one-line note.
2. **Tests first.** For each milestone, write the failing vitest tests from its
   acceptance checks, then write the code that makes them pass.
3. **Run the checks before saying you're done:**
   `pnpm -r build && pnpm -r test && pnpm lint`. If anything fails, fix it; never
   report a milestone done with red checks, and never skip or delete a test to get green.
4. **Keep changes small.** Don't refactor code from earlier milestones unless the
   current milestone needs it.
5. **Ask instead of guessing** if the spec is ambiguous about behavior. Guessing is fine
   for naming and internal structure.
6. **Suggest a git commit** at the end of every green milestone
   (message: `M<n>: <what>`).

## Tech rules

- Node 22+, **pnpm workspaces**, **TypeScript strict**, ESM only (`"type": "module"`).
- Tests: **vitest**. Lint/format: **eslint + prettier** (default configs, no bikeshedding).
- Run TS directly in dev with **tsx**.
- MCP: **`@modelcontextprotocol/sdk`** (stdio transport). Validation: **zod** + **ajv**.
- LLM calls: the **`openai`** npm SDK pointed at Moonshot's OpenAI-compatible API
  (see `docs/SPEC.md` §4). All LLM access goes through `packages/shared/src/llm.ts`; never
  call the API from anywhere else.
- CLI: **commander**. Viewer (milestone 8): **Vite + React + @xyflow/react**.
- No other runtime dependencies without a one-line justification in the PR/commit.

## Safety rules

- Secrets only come from environment variables (`.env`, loaded with `dotenv`).
  **Never** print, log, commit or hard-code an API key. `.env` is gitignored.
- Tests must **not** call the real LLM API. Mock `llm.ts` in unit tests. Only
  `pnpm bench` and `examples/demo-agent` may make real calls.
- The demo tools never touch the real world: `send_message` writes to a file.
- Anything that writes outside the repo folder is forbidden.

## Code style

- Small pure functions; side effects at the edges (CLI, MCP I/O, file I/O).
- Types for every public function. Shared types/schemas live in `packages/shared`.
- Errors: throw typed errors with a clear message that says what to do next.
- Comments explain *why*, not *what*.
