# Waffle landing site

The static Astro landing page for Waffle runs on Cloudflare Workers at [waffle.shaulavo.dev](https://waffle.shaulavo.dev/).

## Run

From this directory, install the pinned dependencies and start the local server:

```sh
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

## Layout

- `src/pages/index.astro` emits the document and preloads the three local fonts.
- `src/components/Landing.astro` renders the layout and initial state as HTML at build time.
- `src/scripts/landing.ts` handles scroll, responsive layout, reduced motion and the scene lifecycle.
- `src/scripts/waffle-scene.ts` is the interactive Three.js scene, bundled by Astro with the pinned `three` dependency.
- Fonts live in `src/assets/`. Scripts and fonts get content-hashed URLs under `dist/_astro/`, and `public/_headers` sets immutable caching for them. HTML is revalidated. Font licenses are in `public/assets/FONTS-LICENSE.txt` and the Three.js MIT notice is in `public/assets/THREE-LICENSE.txt`.

## Build

```sh
bun run typecheck
bun run build
```

[Provenance](../docs/bun-patches.md#waffle-landing-page) · [Waffle](../README.md)
