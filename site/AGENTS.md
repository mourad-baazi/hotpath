# AGENTS.md: instructions for coding agents (Antigravity, Claude Code, Kimi, …)

This folder is the **hotpath.run** landing page for Hotpath, an open-source tool that
records an AI agent's tool calls once and replays the task as a workflow that uses AI
only at the steps that need judgment. Read `README.md` in this folder first.

The site is **already built and working**. Your job is to improve it carefully, not to
start over.

## Stack (do not change without asking)

- Astro, static output. No React/Vue/Svelte on the page; interactivity is small inline
  `<script>` tags in components.
- Tailwind CSS v4 via `@tailwindcss/vite`. Design tokens are CSS variables in
  `src/styles/global.css` and mapped to utilities with `@theme inline` (`bg-surface`,
  `text-muted`, `text-accent`, `text-ai`, `border-line`, …). Custom utilities use
  `@utility` (Tailwind v4 does not allow `@apply` on component classes).
- Fonts: Geist and Geist Mono from `@fontsource-variable`, self-hosted.
- Icons: `lucide-static` through `src/components/Icon.astro`. Lucide has no brand logos:
  GitHub is `src/components/GithubMark.astro`.

## Design rules (from Hotpath's design system)

- Colors only through tokens; never hard-code a hex value in a component.
- Semantic colors: tool step = neutral grey, **AI step = purple (`--ai`)**, side effect =
  amber (`--warn`) with ⚡, failure/drift = red (`--danger`), success = green (`--ok`). The
  story "everything is grey code, one purple AI step" is the pitch: protect it.
- Light and dark themes both work. The OS setting decides unless the visitor clicks the
  toggle (stored in `localStorage.theme`). Test both.
- WCAG AA contrast for every text/background pair (4.5:1 body text). Lighthouse
  accessibility must stay at 100.
- Mobile first: works at 360px with 16px side gutters and **no horizontal scroll**. Grid
  and flex children that hold long code need `min-w-0`.
- Motion: 150–200ms ease-out. The hero animation stays under 2s and is static with
  `prefers-reduced-motion`.
- Voice: honest, technical, short. Only real, measured numbers (they come from
  `docs/BENCHMARK.md` in the main repo). No "revolutionary", no fake urgency, no invented
  testimonials, logos or user counts.

## Content

Edit copy and numbers in `src/content.ts`. The install command is a git clone because
the npm package is not published yet; switch to `npx`/`npm i -g` only once it is.

## Before you say you're done

```bash
npm run build && npm test
```

Then check in a browser at 360px and 1440px, light and dark, and run Lighthouse (mobile):
all four scores must stay ≥ 95 (today: 99/100/100/100). Never add analytics, fonts or
scripts from third-party hosts beyond what `README.md` documents. Never commit secrets;
the waitlist endpoint and analytics token are build-time environment variables.

## Good next improvements

1. A short looping demo video (MP4/WebM, under 1.5 MB) of `hotpath compile` + `hotpath run`
   to replace or sit next to the GIF in the proof section.
2. A `/docs` quick-start page (Astro content collection) mirroring the main README.
3. A pricing teaser for Hotpath Cloud once prices are decided (Free / Pro / Team).
