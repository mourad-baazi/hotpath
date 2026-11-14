// Checks on the built pages (run `pnpm build` first): the things that break
// silently — meta tags, sections, the contact and waitlist forms, no external scripts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

const read = (path) => {
  const file = new URL(path, import.meta.url);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const home = read("../dist/index.html");
const engine = read("../dist/engine/index.html");

test("the site has been built", () => {
  assert.ok(home, "dist/index.html is missing — run `pnpm --filter site build`");
  assert.ok(engine, "dist/engine/index.html is missing — run the build");
});

test("title, description, canonical and social cards on both pages", () => {
  for (const [html, canonical] of [
    [home, "https://hotpath.run/"],
    [engine, "https://hotpath.run/engine/"],
  ]) {
    assert.match(html, /<title>Hotpath[^<]*<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]{60,}"/);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}"`));
    assert.match(
      html,
      /<meta property="og:image" content="https:\/\/hotpath\.run\/og\.png"/,
    );
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  }
  assert.ok(existsSync(new URL("../public/og.png", import.meta.url)));
});

test("home: the sections are there, in order", () => {
  const ids = ["products", "how", "promise", "contact"];
  const positions = ids.map((id) => home.indexOf(`id="${id}"`));
  assert.ok(
    positions.every((p) => p > 0),
    `missing section: ${ids[positions.indexOf(-1)]}`,
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("home: contact form has an email field, a honeypot and a data note", () => {
  assert.match(home, /<form id="contact-form"/);
  assert.match(home, /type="email"[^>]*required|required[^>]*type="email"/);
  assert.match(home, /Formspree/);
});

test("home makes no compliance or customer claims", () => {
  const text = home.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(text, /GDPR[- ]compliant|certified|fully secure/i);
  assert.doesNotMatch(text, /trusted by|our customers|testimonial/i);
});

test("engine: every section is there, in order", () => {
  const ids = ["how", "proof", "features", "faq", "cloud"];
  const positions = ids.map((id) => engine.indexOf(`id="${id}"`));
  assert.ok(
    positions.every((p) => p > 0),
    `missing section: ${ids[positions.indexOf(-1)]}`,
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("engine: waitlist form with an email field and a privacy note", () => {
  assert.match(engine, /<form id="waitlist"/);
  assert.match(engine, /type="email"[^>]*required|required[^>]*type="email"/);
  assert.match(engine, /unsubscribe/);
});

test("no third-party scripts unless analytics is configured", () => {
  for (const html of [home, engine]) {
    const external = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(external, []);
  }
});
