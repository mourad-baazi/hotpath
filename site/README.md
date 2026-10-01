# usehotpath.com

The Hotpath landing page and Hotpath Cloud waitlist. Astro (static output) + Tailwind CSS
v4, the design tokens from `ship/design/DESIGN.md`, Geist fonts and Lucide icons, all
self-hosted. No client framework: the copy button, theme toggle, hero animation and form
are a few small inline scripts.

Lighthouse (mobile, 2026-10-01, light and dark): performance 99, accessibility 100,
best practices 100, SEO 100. No horizontal scroll at 360px.

## Run it

```bash
pnpm install          # from the repo root (site/ is a workspace package)
pnpm --filter site dev      # http://localhost:4321
pnpm --filter site build    # static files in site/dist/
pnpm --filter site test     # checks the built page (run build first)
```

The folder also works on its own (copy it anywhere, then `npm install && npm run build`).

## Edit the content

Almost all copy and numbers live in `src/content.ts`: the hero trace, the three steps,
the stats, the benchmark rows, features and FAQ. Keep numbers in sync with
`docs/BENCHMARK.md`, and keep the voice from DESIGN.md: honest, short, real numbers.

| File                                 | What                                            |
| ------------------------------------ | ----------------------------------------------- |
| `src/pages/index.astro`              | Page order                                      |
| `src/components/Hero.astro`          | Headline, install command, hero animation       |
| `src/components/TraceCollapse.astro` | The signature "trace → workflow" animation      |
| `src/components/Sections.astro`      | How it works, proof, works with, features, FAQ  |
| `src/components/Cloud.astro`         | Cloud teaser and waitlist form                  |
| `src/styles/global.css`              | Design tokens (light, dark) and small utilities |
| `og/og.html`                         | Source of `public/og.png`                       |

## Waitlist (M26)

The form POSTs JSON `{ "email", "automate" }` to `PUBLIC_WAITLIST_ENDPOINT`, set at build
time. Without it, the form tells visitors the waitlist isn't open yet.

**Formspree (simplest):** create a form at formspree.io, copy its endpoint
(`https://formspree.io/f/xxxxxxx`) and set it as `PUBLIC_WAITLIST_ENDPOINT` in your host's
build settings. Formspree accepts JSON with an `Accept: application/json` header, which
the form sends. Test it once: submit your own email and check it arrives.

Any backend that accepts a JSON POST and answers 2xx works (Tally webhook, a Cloudflare
Worker writing to KV…). Keep the privacy note in `Cloud.astro` true for whatever you use.

## Deploy

**Cloudflare Pages:** Create project → connect the GitHub repo →
build command `pnpm --filter site build`, output directory `site/dist`, environment
variables `PUBLIC_WAITLIST_ENDPOINT` (and optionally `PUBLIC_CF_BEACON_TOKEN` for
Cloudflare Web Analytics, cookie-free). Then Custom domains → add `usehotpath.com`;
HTTPS is automatic.

**Vercel:** import the repo, root directory `site`, framework Astro, same environment
variables, then add the domain.

## Regenerate the Open Graph image

`public/og.png` is a 1200×630 screenshot of `og/og.html`. After editing the HTML, open it
in a browser at 1200×630 and save a screenshot, or with Playwright:

```js
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${process.cwd()}/og/og.html`);
await page.screenshot({ path: "public/og.png" });
```
