import { describe, expect, it } from "vitest";

import {
  formatTable,
  llmArgKeys,
  missingMentions,
  sequenceMatches,
  type ScenarioResult,
} from "../src/lib.js";

describe("missingMentions", () => {
  it("is case-insensitive and lists what is absent", () => {
    expect(
      missingMentions("Standup with platform team; sunny", [
        "Standup with Platform team",
        "Sunny",
        "Dentist appointment",
      ]),
    ).toEqual(["Dentist appointment"]);
  });
});

describe("missingMentions typography", () => {
  it("treats non-breaking hyphens, narrow spaces and curly quotes as plain ones", () => {
    const text =
      "Incidents: INC‑101 “Database failover”; uptime 99.95 %; multi‑currency";
    expect(
      missingMentions(text, [
        "INC-101",
        '"Database failover"',
        "99.95 %",
        "multi-currency",
      ]),
    ).toEqual([]);
  });

  it("still reports a mention that is genuinely absent", () => {
    expect(missingMentions("INC‑101 only", ["INC-101", "INC-205"])).toEqual([
      "INC-205",
    ]);
  });
});

describe("sequenceMatches", () => {
  const trace = [
    { tool: "get_emails", args: { date: "2026-10-01" } },
    { tool: "send_message", args: { to: "me", text: "recorded brief" } },
  ];
  const ignore = new Set(["send_message.text"]);

  it("ignores llm-written args but compares everything else", () => {
    const actual = [
      { tool: "get_emails", args: { date: "2026-10-01" } },
      { tool: "send_message", args: { to: "me", text: "fresh text" } },
    ];
    expect(sequenceMatches(actual, trace, ignore)).toBeNull();
  });

  it("reports a differing arg", () => {
    const actual = [
      { tool: "get_emails", args: { date: "2026-10-02" } },
      { tool: "send_message", args: { to: "me", text: "x" } },
    ];
    expect(sequenceMatches(actual, trace, ignore)).toMatch(/call 1.*date/);
  });

  it("reports differing names and lengths", () => {
    expect(sequenceMatches([], trace, ignore)).toMatch(/2 calls/);
    expect(
      sequenceMatches(
        [
          { tool: "get_calendar", args: {} },
          { tool: "send_message", args: { to: "me" } },
        ],
        trace,
        ignore,
      ),
    ).toMatch(/call 1.*get_calendar/);
  });
});

describe("llmArgKeys", () => {
  it("finds tool args fed by an llm step output", () => {
    const keys = llmArgKeys([
      { type: "tool", tool: "get_emails", args: { date: "{{inputs.date}}" } },
      { type: "llm" },
      {
        type: "tool",
        tool: "send_message",
        args: { to: "me", text: "{{steps.s4.output}}" },
      },
    ]);
    expect([...keys]).toEqual(["send_message.text"]);
  });
});

describe("formatTable", () => {
  const rows: ScenarioResult[] = [
    {
      scenario: "same-data",
      pass: true,
      agent: { durationMs: 38200, costUsd: 0.041 },
      hotpath: {
        durationMs: 600,
        costUsd: 0.0021,
        connectMs: 310,
        toolMs: 45,
        llmMs: 1100,
      },
      match: true,
      fallback: false,
    },
    {
      scenario: "new-data",
      pass: true,
      agent: null,
      hotpath: { durationMs: 700, costUsd: 0.0022 },
      match: true,
      fallback: false,
    },
    {
      scenario: "drift",
      pass: true,
      agent: null,
      hotpath: { durationMs: 44100, costUsd: 0.0452 },
      recovered: { durationMs: 600, connectMs: 300, toolMs: 38, llmMs: 90 },
      match: true,
      fallback: true,
    },
  ];

  it("renders speedup, cheaper factor, match and fallback", () => {
    const table = formatTable(rows);
    expect(table).toContain("same-data");
    expect(table).toMatch(/38\.2s \/ \$0\.0410/);
    expect(table).toMatch(/0\.6s \/ \$0\.0021/);
    expect(table).toMatch(/64x/);
    expect(table).toMatch(/20x/);
    expect(table).toMatch(/44\.1s \/ \$0\.0452 → 0\.6s/);
    expect(table).toMatch(/yes → recompiled/);
  });

  it("shows startup, tool and llm time separately", () => {
    const table = formatTable(rows);
    expect(table).toContain("startup + tools + llm");
    expect(table).toContain("310ms + 45ms + 1.1s");
    // drift row shows the recovered (clean) run's split
    expect(table).toContain("300ms + 38ms + 90ms");
    // rows without a split (older results) show a dash instead of crashing
    expect(
      formatTable([{ ...rows[1], hotpath: { durationMs: 1, costUsd: 0 } }]),
    ).toContain("-");
  });

  it("shows failures", () => {
    const table = formatTable([{ ...rows[0], pass: false, match: false }]);
    expect(table).toContain("❌");
  });
});
