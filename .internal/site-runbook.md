# Waffle landing site

These instructions run from the repository’s `site/` directory.

A static Astro landing page configured for Cloudflare Workers Static Assets at
<https://waffle.shaulavo.dev/> (`waffle-site`, configured in `wrangler.jsonc`).
There is no server-side application, React hydration, or DC runtime in the
candidate build.

## Architecture

- `src/pages/index.astro` emits the document and preloads the three local fonts.
- `src/components/Landing.astro` renders the original layout and initial state as
  HTML at build time.
- `src/scripts/landing.ts` handles scroll, responsive layout, reduced motion, and
  the scene lifecycle without React/DC.
- `src/scripts/waffle-scene.ts` preserves the supplied interactive Three.js scene;
  Astro bundles it with the pinned `three` dependency.
- Fonts live in `src/assets/`. Scripts and fonts receive content-hashed URLs under
  `dist/_astro/`; `public/_headers` supplies immutable caching for those URLs.
  HTML is revalidated. Font licenses are in `public/assets/FONTS-LICENSE.txt`;
  Three.js's unchanged MIT notice is in `public/assets/THREE-LICENSE.txt`.

The owner's original self-extracting HTML remains outside the repository. It
contains three design boards, not just this landing page. The extracted React/DC
page is a test reference only and is never included in the production build.
See [the provenance notes](../docs/bun-patches.md) for the adapted scene and layout.

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
bun /work/platform-production/heavy/current/run.js --class build waffle-site-build -- bun run build
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
Stop servers you started with Ctrl-C when comparisons finish. Remove your
extracted fixture after its last consumer stops; retain evidence only while it
has an active review owner.

## Browser parity and performance checks

Install Playwright's pinned browsers if they are not already cached. On this PC,
use `PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright`; do not download a second
browser copy into the system filesystem.

With the two servers running, execute from `site/`:

```sh
PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright \
REFERENCE_URL=http://127.0.0.1:4322/ SITE_URL=http://127.0.0.1:4323/ \
EVIDENCE_DIR=/work/tmp/waffle-site-review \
bun /work/platform-production/heavy/current/run.js --class browser waffle-site-parity -- bun scripts/verify.ts
```

`verify.ts` checks Chromium, Firefox, and WebKit at widths 375, 768, 1280, and 1920. It compares visible text/links, scroll states, hover/focus, and scene
pointer/click states with synchronized animation time, writing screenshots and
`visual-diff.json`. Before comparison, it applies the exact published link destinations,
two action-label, one launch-description and two documentation-caption corrections and `© 2026 Waffle` to the original reference;
[the provenance ledger](../docs/bun-patches.md#waffle-landing-page) records these intentional
departures. It validates the original values before replacing them, does not modify the
candidate, and still fails on any remaining pixel/content mismatch. `ENGINES=chromium`
and `WIDTHS=375,1280` select a smaller diagnostic subset; they do not replace the
full matrix.

```sh
PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright \
OWNER_HTML=/work/tmp/waffle-site-source/waffle-website.html \
BASELINE_HTML=/work/tmp/waffle-site-reference-run/landing.bundle.html \
REFERENCE_URL=http://127.0.0.1:4322/ SITE_URL=http://127.0.0.1:4323/ \
PERFORMANCE_OUTPUT=/work/tmp/waffle-site-performance.json \
bun /work/platform-production/heavy/current/run.js --class browser waffle-site-performance -- bun scripts/performance.ts
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
SITE_URL=http://127.0.0.1:4323/ PERF_MODE=abba ABBA_BLOCKS=5 \
PERFORMANCE_OUTPUT=/work/tmp/waffle-site-performance-abba.json \
bun /work/platform-production/heavy/current/run.js --class browser --quiet waffle-site-performance-abba -- bun scripts/performance.ts
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
