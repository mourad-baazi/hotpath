# Security Policy

## Supported versions

Hotpath is an early-stage project. Only the **latest commit on `main`** is supported:
fixes land there, and older commits do not get patches.

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in a public issue or pull request.

Use GitHub's private reporting: open the repository's **Security** tab, choose
**Advisories**, and click **Report a vulnerability**
(<https://github.com/mourad-baazi/hotpath/security/advisories/new>). This creates a
private advisory that only the maintainer can see.

Please include:

- what the problem is and which part of Hotpath it affects (recorder, compiler, runtime,
  viewer, CLI);
- steps or a minimal example to reproduce it, and the version (commit) you tested;
- the impact you expect, for example code execution, leaking secrets, or sending a
  message twice.

Do not include real API keys or private data in a report; redact traces and workflows
first (they can contain tool results).

The maintainer will acknowledge the report, work on a fix in private, and credit the
reporter in the advisory unless they prefer to stay anonymous. This is a
volunteer-maintained project, so response times are best effort.

## Scope and design notes

- **Secrets** are read only from environment variables (`.env`, which is gitignored) and
  are never logged or committed.
- **Process execution:** the agent fallback is started from an argument list, never
  through a shell, and input names are validated, so input values cannot be interpreted as
  shell syntax.
- **Traces and workflows** (`traces/`, `workflows/`) contain the data returned by the
  tools you record. Treat them as sensitive and do not publish them without reviewing
  them.
- The demo tools never touch the real world: `send_message` writes to a local file.
