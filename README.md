# Hotpath

A JIT compiler for AI agents: record an agent doing a task once, compile it into a
deterministic workflow, re-run it fast and cheap, and self-heal on drift.

## Start building (with Kimi Code or any coding agent)

1. Install Node 22+ and pnpm, then `cd hotpath`.
2. `cp .env.example .env` and put your Moonshot key in `MOONSHOT_API_KEY`
   (needed from milestone 4 on; never commit `.env`).
3. Open your coding agent in this folder and send, one milestone per session:

   > Read AGENTS.md and SPEC.md. Implement milestone M1 only. Write the tests from its
   > acceptance checks first, then make them pass. Run build, test and lint before you
   > say you're done, and tick it in PROGRESS.md.

   Then repeat with M2, M3, … Commit after each green milestone.
4. After M8, run `pnpm bench` — if all three scenarios pass, the MVP works.

See `SPEC.md` for the full spec and `PROGRESS.md` for status.
# hotpath-run
