# Use Hotpath with your agent

`hotpath wrap` routes one MCP server from your agent's config through the Hotpath
recorder, so the next time the agent does the task, every tool call is recorded. It
changes that one server entry and nothing else, saves a backup first, and
`hotpath unwrap` puts the original back.

The commands below use `hp` for the Hotpath CLI. From the repo folder:

```bash
# Git Bash / macOS / Linux
hp() { node node_modules/tsx/dist/cli.mjs packages/cli/src/index.ts "$@"; }
```

```powershell
# PowerShell
function hp { node node_modules/tsx/dist/cli.mjs packages/cli/src/index.ts @args }
```

## Use it with OpenClaw

1. See what will change (nothing is written):

   ```bash
   hp wrap openclaw <server-name> --task my-task --dry-run
   ```

2. Wrap it:

   ```bash
   hp wrap openclaw <server-name> --task my-task
   ```

   Hotpath reads `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`, or `--config`).
   When the `openclaw` CLI is installed, the change is written with
   `openclaw mcp set`, so your JSON5 comments and formatting stay. Without the CLI,
   Hotpath only edits plain-JSON configs.

3. Ask OpenClaw to do the task once. The Gateway picks up the change on the next turn
   when hot reload is on; otherwise restart the Gateway.

4. Compile and replay without OpenClaw:

   ```bash
   hp compile my-task
   hp show my-task
   hp run my-task --dry-run
   ```

5. Put the original server back:

   ```bash
   hp unwrap openclaw <server-name>
   ```

## Use it with Claude Code

```bash
hp wrap claude-code <server-name> --task my-task --dry-run
hp wrap claude-code <server-name> --task my-task
# restart Claude Code, do the task once, then:
hp compile my-task
hp run my-task
hp unwrap claude-code <server-name>
```

Hotpath finds the server the way Claude Code does: local scope (`~/.claude.json`, this
project), then project scope (`.mcp.json`), then user scope (`~/.claude.json`). Run it
from your project folder, or pick one with `--scope local|project|user`. Close Claude
Code before wrapping, since it rewrites `~/.claude.json` while it runs.

## Good to know

- Only stdio servers (a `command`) can be wrapped. Remote `url` servers are refused.
- Wrapping twice is refused; unwrap refuses if you edited the entry since wrapping.
- Backups live in `.hotpath/wrap-backups/` (gitignored, readable only by you), because
  a server entry can contain tokens in `env`.
- The server's `cwd`, `env`, timeouts and tool filters are copied unchanged, and
  `${VAR}` values are never expanded. When you `hotpath run` the task, set the same
  environment variables the server needs.
- Each agent session starts a new recorder, so each one writes its own trace. Compile a
  specific one with `hp compile my-task --trace traces/my-task/<file>.jsonl`.
