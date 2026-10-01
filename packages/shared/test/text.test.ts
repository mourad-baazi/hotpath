import { describe, expect, it } from "vitest";

import { mentions, normalizeText } from "../src/text.js";

describe("normalizeText", () => {
  it("folds typographic dashes, quotes and spaces and lowercases", () => {
    expect(normalizeText("INC‑101  “DB” 99.95 %")).toBe('inc-101 "db" 99.95 %');
  });
});

describe("mentions (strings)", () => {
  it("matches a substring, ignoring case and typography", () => {
    expect(mentions("See INC‑101 now", "inc-101")).toBe(true);
    expect(mentions("Customer’s invoice", "customer's invoice")).toBe(true);
    expect(mentions("nothing here", "INC-101")).toBe(false);
  });
});

describe("mentions (numbers)", () => {
  it("needs the number as a standalone token", () => {
    expect(mentions("high 21°C, low 11°C", 21)).toBe(true);
    expect(mentions("uptime 99.95 %", 99.95)).toBe(true);
    expect(mentions("#412 refund webhook", 412)).toBe(true);
    expect(mentions("14 deploys", 14)).toBe(true);
  });

  it("does not match inside times, dates, decimals or longer numbers", () => {
    expect(mentions("meeting at 14:00", 14)).toBe(false);
    expect(mentions("on 2026-10-04", 10)).toBe(false);
    expect(mentions("uptime 199.95", 99.95)).toBe(false);
    expect(mentions("1411 items", 14)).toBe(false);
    expect(mentions("v14.2", 14)).toBe(false);
  });
});

describe("mentions (other types)", () => {
  it("never matches booleans, null or objects", () => {
    expect(mentions("true", true)).toBe(false);
    expect(mentions("null", null)).toBe(false);
  });
});
