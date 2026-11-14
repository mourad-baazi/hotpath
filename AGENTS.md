# AGENTS.md

Guidance for AI coding agents (and humans) working on Hotpath.

Hotpath records an agent's MCP tool calls, compiles the trace into a deterministic
workflow, and replays it with an LLM only at judgment steps; on drift it falls back to
the agent and recompiles. See `README.md` for usage and `docs/SPEC.md` for the data
formats and the MVP design.

## Before you finish any change

- Run `pnpm -r build && pnpm -r test && pnpm lint`. All must pass.
- Never skip, delete or weaken a test to get green.
- Add or update tests for every behavior change (vitest, tests first when practical).
- One milestone per change; tick it in `docs/PROGRESS.md` when its acceptance checks pass.

## Project rules

- Node 22+, pnpm workspaces, TypeScript strict, ESM only.
- MCP via `@modelcontextprotocol/sdk` (stdio). Validation with zod + ajv.
- All LLM calls go through `packages/shared/src/llm.ts` (OpenAI-compatible API,
  configured by `LLM_API_KEY`, `LLM_BASE_URL` and the `HOTPATH_*_MODEL` env vars).
- Shared types and schemas live in `packages/shared`.
- No new runtime dependency without a one-line justification in the commit message.

## Safety

- Never use a shell to run commands: argument arrays via `cross-spawn` only.
- Secrets only from environment variables (`.env`, gitignored). Never print, log or
  commit an API key.
- Tests never call a real LLM API; mock `llm.ts`. Only `pnpm bench` and
  `examples/demo-agent` make real calls.
- Demo tools never touch the real world (`send_message` writes to a file).
- Never write outside the repo folder.
- Keep the security scan (`plugin-scanner lint` on a clean export) at ≥ 80 with no high
  findings; we aim for 100.

## Style

- Small pure functions; side effects at the edges (CLI, MCP I/O, file I/O).
- Typed errors with a message that says what to do next.
- Comments explain why, not what.
- Commit messages: short and descriptive. Do not add `Co-Authored-By` or other AI
  attribution lines.
