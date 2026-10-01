// Checks on the built page (run `pnpm build` first): the things that break
// silently — meta tags, sections, the waitlist form, no external scripts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

const file = new URL("../dist/index.html", import.meta.url);
const html = existsSync(file) ? readFileSync(file, "utf8") : "";

test("the site has been built", () => {
  assert.ok(
    html,
    "dist/index.html is missing — run `pnpm --filter site build`",
  );
});

test("title, description, canonical and social cards", () => {
  assert.match(html, /<title>Hotpath: [^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{60,}"/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/hotpath\.run\/"/,
  );
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/hotpath\.run\/og\.png"/,
  );
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.ok(existsSync(new URL("../public/og.png", import.meta.url)));
});

test("every section is there, in order", () => {
  const ids = ["how", "proof", "features", "faq", "cloud"];
  const positions = ids.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(
    positions.every((p) => p > 0),
    `missing section: ${ids[positions.indexOf(-1)]}`,
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("waitlist form with an email field and a privacy note", () => {
  assert.match(html, /<form id="waitlist"/);
  assert.match(html, /type="email"[^>]*required|required[^>]*type="email"/);
  assert.match(html, /unsubscribe/);
});

test("no third-party scripts unless analytics is configured", () => {
  const external = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(external, []);
});
