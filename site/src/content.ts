// Copy and data for the landing page, kept in one place so it is easy to edit.

export const GITHUB_URL = "https://github.com/mourad-baazi/hotpath";
export const BENCHMARK_URL = `${GITHUB_URL}/blob/main/docs/BENCHMARK.md`;
export const DOCS_URL = `${GITHUB_URL}#readme`;

export const INSTALL =
  "git clone https://github.com/mourad-baazi/hotpath && cd hotpath && pnpm install";

/** The hero animation: an agent's trace, then the workflow Hotpath keeps. */
export interface TraceRow {
  kind: "fail" | "ok" | "ai";
  tool: string;
  trace?: string;
  error?: string;
  step?: string;
  flow?: string;
  effect?: boolean;
}

export const TRACE: TraceRow[] = [
  {
    kind: "fail",
    tool: "get_emails",
    trace: 'date: "today"',
    error: "invalid date",
  },
  {
    kind: "ok",
    tool: "get_emails",
    trace: 'date: "2026-10-01"',
    step: "s1",
    flow: "date: {{inputs.date}}",
  },
  {
    kind: "fail",
    tool: "get_calendar",
    trace: "{}",
    error: "date is required",
  },
  {
    kind: "ok",
    tool: "get_calendar",
    trace: 'date: "2026-10-01"',
    step: "s2",
    flow: "date: {{inputs.date}}",
  },
  {
    kind: "fail",
    tool: "get_weather",
    trace: 'city: "paris, fr"',
    error: "unknown city",
  },
  {
    kind: "ok",
    tool: "get_weather",
    trace: 'city: "Paris", date: "2026-10-01"',
    step: "s3",
    flow: 'city: "Paris", date: {{inputs.date}}',
  },
  {
    kind: "ai",
    tool: "AI step",
    step: "s4",
    flow: "cheap model writes the brief from s1–s3",
  },
  {
    kind: "fail",
    tool: "send_message",
    trace: 'to: "Me"',
    error: "unknown recipient",
  },
  {
    kind: "ok",
    tool: "send_message",
    trace: 'to: "me", text: "Good morning! 3 emails…"',
    step: "s5",
    flow: 'to: "me", text: {{steps.s4.output}}',
    effect: true,
  },
];

export const STEPS = [
  {
    n: "01",
    title: "Record",
    icon: "Radio",
    text: "Hotpath sits between your agent and its MCP server as a proxy. Do the task once, the way you already do; every tool call lands in a trace.",
    cmd: "hotpath wrap claude-code my-server --task brief",
    out: "wrapped “my-server”: records task “brief”",
  },
  {
    n: "02",
    title: "Compile",
    icon: "Workflow",
    text: "Failed and retried calls are dropped. Your inputs become {{inputs}}, values passed between tools become references, written text becomes one AI step, repeats over a list become a loop.",
    cmd: "hotpath compile brief",
    out: "compiled 5 steps (dropped 4 failed/retried calls)",
  },
  {
    n: "03",
    title: "Run",
    icon: "Play",
    text: "Tool steps run as plain code. Only the judgment step calls a cheap model. Guards check every result; on drift it falls back to your agent and recompiles.",
    cmd: "hotpath run brief --input date=2026-10-02",
    out: "✓ brief in 0.5s, $0.0009 (1 llm call)",
  },
] as const;

export const STATS = [
  {
    value: "8 → 5",
    label: "tool calls → steps",
    note: "4 failed calls dropped",
  },
  {
    value: "~0.5 s",
    label: "replay on new data",
    note: "agent: one model call per step",
  },
  {
    value: "1",
    label: "cheap AI call per run",
    note: "only where text is written",
  },
  { value: "~$0.001", label: "per run", note: "at the configured prices" },
] as const;

/** One complete benchmark run (docs/BENCHMARK.md), rate-limit waits excluded. */
export const BENCH = [
  {
    scenario: "morning-brief · same data",
    agent: "3.7s · $0.0206",
    hotpath: "0.9s · $0.0021",
    faster: "4×",
    cheaper: "10×",
  },
  {
    scenario: "morning-brief · new data",
    agent: "3.3s · $0.0175",
    hotpath: "1.0s · $0.0018",
    faster: "3×",
    cheaper: "10×",
  },
  {
    scenario: "weekly-report · same data",
    agent: "6.7s · $0.0503",
    hotpath: "1.6s · $0.0039",
    faster: "4×",
    cheaper: "13×",
  },
  {
    scenario: "weekly-report · new data",
    agent: "6.7s · $0.0438",
    hotpath: "1.3s · $0.0038",
    faster: "5×",
    cheaper: "12×",
  },
] as const;

export const FEATURES = [
  {
    icon: "ListX",
    title: "Drops the agent's mistakes",
    text: "Wrong arguments, retries and errors stay in the trace and out of the workflow, so a replay never repeats them.",
  },
  {
    icon: "Sparkles",
    title: "AI only where judgment is needed",
    text: "Fetching and sending run as code. A cheap model writes only the parts that need words, grounded in this run's data.",
  },
  {
    icon: "ShieldCheck",
    title: "Self-heals on drift",
    text: "Every result is checked against what was recorded. If a tool changes, Hotpath runs your agent once and recompiles, never after a side effect.",
  },
  {
    icon: "CalendarClock",
    title: "Runs on a schedule",
    text: "Cron schedules with @today-style inputs. Safe by default: side effects stay dry-run and the agent isn't started until you allow it.",
  },
  {
    icon: "Repeat",
    title: "Loops over lists",
    text: "“For each email, open it” compiles into a loop, so the workflow still works when tomorrow's list is longer.",
  },
  {
    icon: "FileJson",
    title: "Plain files, local-first",
    text: "Traces, workflows and run history are JSON in your folder. Read them, edit them, commit them. Apache-2.0.",
  },
] as const;

export const FAQ = [
  {
    q: "Is Hotpath another agent?",
    a: "No. Your agent (Claude Code, OpenClaw, your own) stays the brain: it figures a task out the first time. Hotpath is the muscle memory: it replays what worked, fast and cheap, and calls the agent back when something changes.",
  },
  {
    q: "Which tasks can it compile?",
    a: "Sequences of tool calls, data passed between them, written text, and loops over a list, through stdio MCP servers. Tasks that branch (if this, do that) aren't compiled yet; they keep running through your agent.",
  },
  {
    q: "What happens when a tool or its data changes?",
    a: "Each step has a guard (the result's shape, and for AI steps the facts the text must mention). A failed guard is drift: Hotpath falls back to your agent for that run and recompiles. If a side effect already ran, it stops instead, so nothing is sent twice.",
  },
  {
    q: "Where does my data go?",
    a: "Nowhere new. Traces, workflows and run history are files in your project folder. AI steps call the OpenAI-compatible provider you configure (Groq, OpenAI, Moonshot, NVIDIA…), and nothing else.",
  },
  {
    q: "How mature is it?",
    a: "Early. The record → compile → run loop, drift fallback, schedules and loops work and are tested; the benchmark covers small demo tasks with a single run each. Read the limits in BENCHMARK.md before relying on the numbers.",
  },
  {
    q: "What does it cost?",
    a: "The CLI is free and open source (Apache-2.0). You pay your model provider for the one cheap AI call per run. Hotpath Cloud, for running tasks without your laptop, will be a paid option.",
  },
] as const;
