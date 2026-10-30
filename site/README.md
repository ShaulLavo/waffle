# Waffle landing site

The static Astro landing page for Waffle runs on Cloudflare Workers at [waffle.shaulavo.dev](https://waffle.shaulavo.dev/).

## Run

From this directory, install the pinned dependencies and start the local server:

```sh
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

## Layout

- `src/pages/index.astro` emits the document head, declares and preloads the three local fonts, and imports the stylesheet.
- `src/components/Landing.astro` renders the whole page as static HTML. The code sample is highlighted at build time, so no highlighter ships.
- `src/styles/site.css` holds the design tokens and every style. One container width, one ink colour, one border and one lift shadow keep edges and depths consistent.
- `src/scripts/landing.ts` runs the scroll story. The page scrolls natively; the script turns the scroll offset into one progress value for the scene, frames the waffle in the free part of the screen and sizes the card deck. It writes no layout styles while scrolling.
- `src/scripts/waffle-scene.ts` is the interactive Three.js scene, loaded after first paint and bundled with the pinned `three` dependency.
- Fonts live in `src/assets/` as Latin subsets. Scripts and fonts get content-hashed URLs under `dist/_astro/`, and `public/_headers` sets immutable caching for them. HTML is revalidated. Font licenses are in `public/assets/FONTS-LICENSE.txt` and the Three.js MIT notice is in `public/assets/THREE-LICENSE.txt`.

Append `?full-quality` to the URL to turn off the scene's adaptive pixel density, for screenshots on slow machines.

## Build

```sh
bun run typecheck
bun run build
```

With the production build served by `bun run preview`, `SITE_URL=http://127.0.0.1:4321/ bun run smoke` checks Chromium at phone, tablet and desktop sizes: no browser errors, the scene paints, the story reaches its last step, no text spills sideways and every link has a target. Set `ENGINES=chromium,firefox,webkit` for all three engines.

[Provenance](../docs/bun-patches.md#waffle-landing-page) · [Waffle](../README.md)
