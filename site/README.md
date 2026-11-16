# Waffle landing site

The static Astro landing page for Waffle runs on Cloudflare Workers at [waffle.shaulavo.dev](https://waffle.shaulavo.dev/). The previous design stays at `/old/`.

## Run

From this directory, install the pinned dependencies and start the local server:

```sh
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

## Build and check

```sh
bun run typecheck
bun run build
bun run preview --host 127.0.0.1 --port 4323
SITE_URL=http://127.0.0.1:4323/ ENGINES=chromium,firefox,webkit bun run smoke
```

[Provenance](../docs/bun-patches.md#waffle-landing-page) · [Waffle](../README.md)
