# Waffle landing site

These instructions run from the repository’s `site/` directory.

A static Astro landing page configured for Cloudflare Workers Static Assets at
<https://waffle.shaulavo.dev/> (`waffle-site`, configured in `wrangler.jsonc`).
There is no server-side application, React hydration, or DC runtime in the
candidate build.

## Architecture

The site has three pages. `/` is the process-table design (2026-11-16), `/old/` keeps the
2026-10-30 Three.js design with `noindex`, and `404.html` is served with a 404 status for any
missing URL (`not_found_handling: "404-page"` in `wrangler.jsonc`).

- `src/layouts/Page.astro` is the head for `/` and the 404 page: title, description, canonical,
  `theme-color`, the font rules and the first-screen font preloads. It imports
  `src/styles/main.css`, which holds every style of the new design.
- `src/pages/index.astro` and `src/components/Home.astro` render `/` as static HTML. The code
  sample is the `createRuntime` example read from `docs/getting-started.md` and highlighted at
  build time; the heading's line count is computed from it, so neither can drift.
- `src/scripts/home/` draws and runs the page: `iso.ts` builds the isometric SVG waffles,
  `board.ts` changes them (blocks, tags, pipes, file marks, the comet), `session.ts` runs the
  scripted hero session and keeps the terminal at eight rows, `details.ts` loops the four "How
  it works" drawings, `parts.ts` slides the parts-list highlight, and `gate.ts` holds every loop
  while the visitor pauses it, its section is off screen or the tab is hidden. With reduced
  motion, the session and details show one still frame.
- `src/pages/404.astro` is the designed not-found page.
- `/old/`: `src/pages/old/index.astro` emits its head; `src/components/old/Landing.astro` and
  `src/styles/old.css` render it; `src/scripts/old/landing.ts` maps native scroll to scene
  progress; `src/scripts/old/waffle-scene.ts` is the Three.js scene, loaded after first paint.
  Three.js is bundled only into `/old/`. Append `?full-quality` to the `/old/` URL to turn off the
  scene's adaptive pixel density, for screenshots on slow machines.
- Fonts live in `src/assets/` as instanced Latin subsets (sources and sizes in
  `docs/bun-patches.md`). The new page uses `bricolage-grotesque-text.woff2`,
  `bricolage-grotesque-display.woff2`, `martian-mono.woff2` and the inlined
  `fredoka-wordmark.woff2`; `/old/` keeps its 2026-10-30 files. Scripts and fonts receive
  content-hashed URLs under `dist/_astro/`; `public/_headers` supplies immutable caching for
  those URLs. HTML is revalidated. Font licenses are in `public/assets/FONTS-LICENSE.txt`;
  Three.js's unchanged MIT notice is in `public/assets/THREE-LICENSE.txt`.
- `public/robots.txt` and `public/sitemap.xml` list only `/`.

The 2026-10-30 redesign (now `/old/`) departs from the owner's original self-extracting HTML on
purpose; see [the provenance notes](../docs/bun-patches.md#waffle-landing-page). The original
export stays outside the repository and remains useful as a performance and visibility baseline
for `/old/`.

## Build and local development

Run these commands from `site/`, using the committed lockfile:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run dev --host 127.0.0.1
# Or serve the production build:
bun run preview --host 127.0.0.1 --port 4323
```

On the owner's PC, source the workspace environment first where required. Use
its shared heavy runner for builds and browser jobs; for example, replace the
plain build command above with:

```sh
bun /work/heavy-runner/current/run.js --host local --class build waffle-site-build -- bun run build
```

Do not rebuild `dist/` while a comparison is measuring it.

## Recreate the reference without changing the source

The extractor reads the original export, selects landing page
`281df726-0eff-4ae0-a4d0-749fd2cd790e`, decompresses its captured assets, restores
the captured React/ReactDOM script order, and rewrites asset IDs to local URLs.
It performs no downloads and does not modify the source. Its output directory
must not already exist; parent directories must exist.

```sh
bun scripts/extract-reference.ts \
  --input /work/tmp/waffle-site-source/waffle-website.html \
  --out /work/tmp/waffle-site-reference-run
```

Output:

- `index.html` and `assets/`: runnable extracted landing, retaining React/DC.
- `landing.bundle.html`: byte-exact nested standalone landing for the meaningful
  bundled-page size/performance baseline.
- `reference.json`: source, landing, HTML, and asset sizes/SHA-256 hashes for
  reproducibility. The original source's SHA-256 is
  `f845e81ca6cf60d3f832f88b48f4ceaf0a646c0237fe0f0dedfa31c680774383`.

Only test fixtures are generated. Do not copy the source export or extracted
React/DC assets into this repository. Serve the output in a separate terminal:

```sh
python3 -m http.server 4322 --bind 127.0.0.1 \
  --directory /work/tmp/waffle-site-reference-run
```

Serve `dist/` with the preview command above on port 4323. Reuse existing task
servers if those ports are already owned; never stop another run's processes.
`bun run preview` detaches the server and prints its pid; stop it with `bun run preview stop`
from `site/` (or Ctrl-C for the Python server) when comparisons finish. Remove your
extracted fixture after its last consumer stops; retain evidence only while it
has an active review owner.

## Browser smoke, visibility and performance checks

With the production build served on port 4323, run the smoke check in all three engines:

```sh
PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright \
SITE_URL=http://127.0.0.1:4323/ ENGINES=chromium,firefox,webkit \
bun /work/heavy-runner/current/run.js --host local --class browser waffle-site-smoke -- bun scripts/smoke.ts
```

It checks phone, tablet and desktop sizes, plus a reduced-motion phone, on three pages:

- `/`: no browser errors, failed requests or requests to another origin; the drawing has
  sixteen slots; a block rises; the pause button and scrolling away both freeze the session
  and the detail loops resume on screen; the terminal holds eight full rows; reduced motion runs
  no animations; no text spills sideways; every link has a target and none leads to `/old/`;
  footer links are at least 44 px tall; on desktop, the skip link is the first tab stop and
  every stop shows an outline that nothing clips or covers.
- `/old/`: a painted scene (or the no-WebGL note where the engine has no WebGL, as headless
  Firefox on this PC does), a story that reaches the sky, `noindex`, text inside the viewport
  and links with targets.
- `/no-such-page/`: a 404 status with the designed page. `astro preview` serves `404.html` with
  that status, like the Workers `404-page` handling.

Run new or changed checks two or three times before merging to catch races.

`visibility.ts` and `performance.ts` measure the Three.js scene, so their candidate defaults to
`http://127.0.0.1:4323/old/`; pass `SITE_URL` with the `/old/` path when overriding it.
`visibility.ts` compares the reference and candidate scene loops: both must stop drawing while
the canvas is off screen and resume without a time jump. It needs the reference server on port
4322 or `REFERENCE_URL` pointing at another build of the previous page.

```sh
PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright \
OWNER_HTML=/work/tmp/waffle-site-source/waffle-website.html \
BASELINE_HTML=/work/tmp/waffle-site-reference-run/landing.bundle.html \
REFERENCE_URL=http://127.0.0.1:4322/ SITE_URL=http://127.0.0.1:4323/old/ \
PERFORMANCE_OUTPUT=/work/tmp/waffle-site-performance.json \
bun /work/heavy-runner/current/run.js --host local --class browser waffle-site-performance -- bun scripts/performance.ts
```

`performance.ts` runs three cold Chromium navigations each for the standalone
bundled landing, extracted React/DC page, and candidate. It records FCP, LCP,
CLS, long tasks, DOMContentLoaded/load, HTTP requests, actual CDP transfer bytes,
and modeled per-response gzip-9/Brotli-11 bytes. It owns and closes its temporary
baseline server/browser, but preserves the two supplied servers. No Lighthouse
score is produced: the eight-second, unthrottled desktop loopback measurement
is diagnostic, and bounded post-FCP blocking time is **not** Lighthouse TBT
through time-to-interactive. Modeled compression is not an observed compressed
network transfer. The full three-board source is size context only, never the
landing-page baseline. Compare on the same host and record concurrent load.

When timing differences are noisy, use the paired mode rather than comparing
separate short runs. Five ABBA blocks produce ten original and ten candidate
samples with fresh browser contexts, cache disabled, the same SwiftShader
renderer, and a fixed eight-second observation window. This records individual
samples, host load/CPU, medians, spread, and early versus steady-state blocking.
On the owner's PC, request a quiet heavy-runner slot:

```sh
PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright \
OWNER_HTML=/work/tmp/waffle-site-source/waffle-website.html \
BASELINE_HTML=/work/tmp/waffle-site-reference-run/landing.bundle.html \
SITE_URL=http://127.0.0.1:4323/old/ PERF_MODE=abba ABBA_BLOCKS=5 \
PERFORMANCE_OUTPUT=/work/tmp/waffle-site-performance-abba.json \
bun /work/heavy-runner/current/run.js --host local --class browser --quiet waffle-site-performance-abba -- bun scripts/performance.ts
```

Keep the production output unchanged throughout the run. Report the full spread
and paired contrasts; a difference smaller than that variation is not a timing
win or regression. Trace long tasks before changing scene behavior to address a
repeatable regression.

## Deploy, inspect, and roll back

Use the pinned Wrangler through `bun run wrangler`, not a global install or
`cf deploy`. Build and check the site first. Before a first deployment, verify
that the configured account and exact hostname are the intended target and
that no other service owns that hostname; do not replace unrelated DNS/routes.
`workers_dev` and preview URLs are disabled in the checked-in configuration.

On the owner's workstation, `cf` is authenticated while Wrangler is not. This
helper refreshes that login and passes its token **only in the child command's
environment**. It disables shell tracing, never prints the token, and never
writes a credential file. Do not run it under an environment-dumping logger.
If `cf auth whoami` fails, stop and have the owner renew their login with
`cf auth login`; do not change credentials or fall back to an unrelated account.

```sh
with_cf_token() (
  set +x
  cf auth whoami >/dev/null || exit
  token="$(python3 -I -c 'import json, pathlib; print(json.loads((pathlib.Path.home()/".config/cloudflare/config/default.json").read_text())["oauth_token"])')" || exit
  test -n "$token" || exit 1
  CLOUDFLARE_API_TOKEN="$token" "$@"
)

# Packaging check, followed by the actual authorized publication:
with_cf_token bun run wrangler deploy --config wrangler.jsonc --dry-run
with_cf_token bun run wrangler deploy --config wrangler.jsonc

# Inspect the active deployment and available rollback versions:
with_cf_token bun run wrangler deployments list --config wrangler.jsonc
with_cf_token bun run wrangler versions list --config wrangler.jsonc

# Replace VERSION_ID with a verified prior known-good version:
with_cf_token bun run wrangler rollback VERSION_ID --config wrangler.jsonc
```

In CI or on another host, supply an already-authorized scoped
`CLOUDFLARE_API_TOKEN` through that environment's secret manager instead of
reading this workstation's login. `bun run deploy` is a build-and-publish
convenience command and also requires that credential environment.

After publication or rollback, fetch the live HTML and one hashed script/font
referenced by it. Verify HTTP 200, correct content, revalidation for HTML, and
`Cache-Control: public, max-age=31536000, immutable` for hashed assets. Recheck
`deployments list` and record the deployed version. A successful upload/dry run
alone does not verify the site. Rollback changes the active Worker version;
it is not a backup/restore of external data, DNS, or unrelated resources.
