# Contributing to Hotpath

Thanks for your interest! Hotpath is an MVP, so the most useful contributions are
bug reports, small focused fixes, and well-scoped milestones from the roadmap.

## Setup

You need Node 22+ and pnpm 9+.

```bash
git clone https://github.com/mourad-baazi/hotpath.git
cd hotpath
pnpm install
cp .env.example .env   # only needed for the demo agent and `pnpm bench`
```

Never commit `.env` or paste an API key into code, logs or issues. Secrets come only
from environment variables.

## Running the checks

```bash
pnpm -r build     # type-check every package (TypeScript strict, ESM only)
pnpm -r test      # vitest, no API key needed
pnpm lint         # eslint + prettier --check
```

All three must pass before you open a PR. To fix formatting: `pnpm exec prettier --write .`

Tests must **not** call a real LLM. Mock `packages/shared/src/llm.ts` (see
`packages/runtime/test/` for examples). Only `pnpm bench` and `examples/demo-agent`
make real calls, and all LLM access goes through `llm.ts`.

`pnpm bench` runs the end-to-end benchmark against a real model and costs a few cents;
you don't need it for most changes.

## Pull requests: one milestone per PR

- Keep each PR to one milestone or one focused change (see `SPEC.md` §6 and `PROGRESS.md`).
- **Tests first:** write the failing vitest tests from the acceptance checks, then the code.
- Don't refactor code from earlier milestones unless your change needs it.
- Don't skip or delete a test to get green.
- No new runtime dependencies without a one-line justification in the PR description.
- Ask in an issue first if the spec is ambiguous about behavior; guessing is fine for
  naming and internal structure.
- Commit messages: `M<n>: <what>` for milestone work, otherwise a short imperative summary.

## Code style

- Small pure functions; side effects at the edges (CLI, MCP I/O, file I/O).
- Types for every public function; shared types and schemas live in `packages/shared`.
- Errors are typed and say what to do next.
- Comments explain _why_, not _what_.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include the command you ran, what you expected, what
happened, your OS and Node version, and the relevant trace or workflow if you can share it
(remove anything private first).

By contributing you agree that your contributions are licensed under the Apache-2.0 license.
