# hotpath.run

The Hotpath landing page and Hotpath Cloud waitlist. Astro (static output) + Tailwind CSS
v4, the "heat signature" design from `ship/design/DESIGN.md` (Instrument Serif, Geist,
Martian Mono, Lucide icons, all self-hosted). No client framework: the copy button, theme
toggle, animations and form are a few small inline scripts.

Lighthouse (mobile, 2026-10-01, light and dark): performance 95, accessibility 100,
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
| `src/components/Hero.astro`          | Headline, install ticket, stats bar             |
| `src/components/HeatField.astro`     | The hero's thermal scan with the hot path       |
| `src/components/TraceCollapse.astro` | The "trace → workflow" compile animation        |
| `src/components/Sections.astro`      | How it works, proof, works with, features, FAQ  |
| `src/components/Cloud.astro`         | Cloud teaser and waitlist form                  |
| `src/styles/global.css`              | Design tokens (light, dark) and small utilities |
| `src/pages/og.astro`                 | Source of `public/og.png` (the social card)     |

## Waitlist (M26)

The form POSTs JSON `{ "email", "automate" }` to the Formspree form in `src/content.ts`
(`WAITLIST_ENDPOINT`). Set `PUBLIC_WAITLIST_ENDPOINT` at build time to use another
backend. Signups show up in the Formspree dashboard.

**Formspree (simplest):** create a form at formspree.io, copy its endpoint
(`https://formspree.io/f/xxxxxxx`) and set it as `PUBLIC_WAITLIST_ENDPOINT` in your host's
build settings. Formspree accepts JSON with an `Accept: application/json` header, which
the form sends. Test it once: submit your own email and check it arrives.

Any backend that accepts a JSON POST and answers 2xx works (Tally webhook, a Cloudflare
Worker writing to KV…). Keep the privacy note in `Cloud.astro` true for whatever you use.

## Deploy

The domain `hotpath.run` is registered at Namecheap; the site is hosted on Cloudflare
Pages (free).

1. **Move DNS to Cloudflare** (needed for a root domain on Pages): in Cloudflare,
   Add a domain → `hotpath.run` → Free plan. Cloudflare shows two nameservers. In
   Namecheap → Domain List → `hotpath.run` → Manage → Nameservers → **Custom DNS**, paste
   both and save. It usually takes minutes, up to 24 hours.
2. **Create the Pages project:** Workers & Pages → Create → Pages → Connect to Git →
   the repo. Build command `pnpm --filter site build`, output directory `site/dist`.
   No environment variables are needed (optional: `PUBLIC_CF_BEACON_TOKEN` for
   cookie-free Cloudflare Web Analytics, `PUBLIC_WAITLIST_ENDPOINT` to override the form).
3. **Connect the domain:** the Pages project → Custom domains → add `hotpath.run`, then
   `www.hotpath.run` (Cloudflare can redirect www to the root). HTTPS is automatic.
4. **Test:** open https://hotpath.run, sign up with your own email, check it in Formspree.

**Vercel instead:** import the repo, root directory `site`, framework Astro, then add
`hotpath.run`; in Namecheap → Advanced DNS add the A record and CNAME Vercel shows.

## Regenerate the Open Graph image

`public/og.png` is a 1200×630 screenshot of the `/og` page (same fonts, tokens and heat
field as the site). Run `pnpm --filter site dev`, open http://localhost:4321/og/ at
1200×630 and save a screenshot, or with Playwright:

```js
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("http://localhost:4321/og/");
await page.screenshot({ path: "public/og.png" });
```
