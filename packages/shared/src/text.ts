// Matching "does this generated text mention that value?" (llm grounding
// guard, bench). Models type typographic variants of what they were given
// (U+2011 hyphens, narrow no-break spaces, curly quotes), so fold those first.

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strings: normalized substring. Numbers: a standalone token, so 14 does not
 * match "14:00", "2026-10-14", "1411" or "v14.2". Anything else: false.
 */
export function mentions(text: string, value: unknown): boolean {
  if (typeof value === "string") {
    return normalizeText(text).includes(normalizeText(value));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const token = escapeRegExp(String(value));
    const standalone = new RegExp(
      `(?<![\\d.,:/-])${token}(?!\\d|[.,:/]\\d|-\\d)`,
    );
    return standalone.test(normalizeText(text));
  }
  return false;
}
