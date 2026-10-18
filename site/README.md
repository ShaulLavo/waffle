# Waffle landing site

The static Astro landing page for Waffle runs on Cloudflare Workers at [waffle.shaulavo.dev](https://waffle.shaulavo.dev/).

## Run

From this directory, install the pinned dependencies and start the local server:

```sh
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

## Build

```sh
bun run typecheck
bun run build
```

[Development, browser checks and deployment](../docs/site.md) · [Provenance](../docs/bun-patches.md#waffle-landing-page) · [Waffle](../README.md)
