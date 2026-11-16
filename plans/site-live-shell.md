# A live shell on the landing page

Status: **Approved** (owner, 2026-11-16). Scheduled after the process-table landing page.

The landing page at `/` shows a scripted demo session: the terminal replays a fixed transcript
and the process-table drawing follows the script (`site/src/scripts/home/session.ts`). The terminal bar
says "demo session".

The headline already says "A kernel is running in this tab." (owner's choice, 2026-11-16: keep
that line now and make it true later). Until this plan lands, that headline is ahead of the page.
Closing that gap is the point of this plan.

## Finish line

- The hero terminal runs bash-web on Waffle inside the page, with the program packages the
  transcript uses (coreutils, grep, git, python).
- The process-table drawing is fed by the runtime's process table: a block rises when a process
  spawns and sinks when it exits, and a bridge appears for each open pipe. The gauges read the same
  source.
- While the visitor is idle, a demo types commands into the real shell. When the visitor types,
  the demo stops and hands the shell over.
- The headline "A kernel is running in this tab." is literally true, and the "demo session" note
  goes.
- The site's smoke check covers the live shell in Chromium, Firefox and WebKit, phone and desktop.

## Open questions

- **Page weight.** How large are the shell, the runtime and the four packages, and how do they
  load lazily (after first paint, or on scroll into view) so the first screen stays as fast as
  the static page? The scripted session stays as the first frame until the shell is ready.
- **Cross-origin isolation.** Waffle needs `SharedArrayBuffer`, so the site must be served with
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (`site/public/_headers`).
  Check what that breaks for outbound links and any embedded resources.
- **Process events.** Does Waffle expose spawn, exit and pipe events a page can subscribe to, or
  does the drawing need a new public observer API? That would be a host-facing change: read
  `docs/host-abi.md` and `docs/private-authority.md` first.
- **iPhone Safari memory.** Safari reserves the full declared maximum of shared memory up front
  (`docs/shared-memory.md`). The page must fit the iPhone reservation budget, and fall back to the
  scripted session when it cannot start.

## Other leftovers from the site audit

- **Share image.** An `og:image` for `/`, generated at build time from text sources (SVG or
  markup rendered to PNG during `astro build`), because the repository does not take checked-in
  images.
- **Phone menu.** On phones the header hides the section links (How it works, The API, Parts
  list). Add a small menu so they are reachable without scrolling.
