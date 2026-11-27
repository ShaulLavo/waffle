# Vite 8 in the playground

Status: **Completed for stock Vite 8 React (2026-11-27); `@tailwindcss/vite` v4 gap isolated to `bun-wasm` (`O_NONBLOCK`).** Stock Vite 8 React passes the full local finish line across Chromium, Firefox, and WebKit on both `browser` (native) and `quickjs` (`shared-group`) engines. No Waffle runtime bug blocks Vite 8 React or Vite 8 + Tailwind v4.

Prepared 2026-11-04 from Waffle `745959ed` (package 0.0.110) and bun-wasm `5312b1fb`, which
consumes the `waffle-v0.0.110` release tarball. Owner request: Waffle track, 2026-10-29 (local
reference `/work/reports/wave-20261029/README.md`, "Vite 8" item and ownership table).

## Finish line

A stock Vite 8 React app, unmodified from its template, passes all of these in one run against a
**local** bun-wasm playground built from recorded bun-wasm and Waffle commits:

1. `bun install` exits 0 with no overrides, stubs or added packages.
2. `vite` dev prints its ready line and the app's page loads through the playground preview, both
   the embedded preview frame and the standalone `__preview/<port>/` URL.
3. A real counter click changes the rendered count.
4. A source edit to `src/App.tsx` reaches the open page through Vite HMR without a manual reload.
5. A manual reload shows the edited source.
6. Keyboard Ctrl-C in the terminal stops dev, the listener disappears and the prompt is usable.
7. `vite build` exits 0 and writes a nonempty `dist/index.html` plus JavaScript and CSS assets.

A public deployment, a build pass alone, or a ready line alone is not this finish line. Running it
on the public site after local acceptance is a separate publication step for the bun-wasm owner.

## What is already known

Three runs exist. They used different fixtures, runtime identities and preview paths, so none
contradicts another and none is local acceptance.

### A. Private playground, October 30 (historical accepted proof)

The private fxj6 playground at generation 24, later 25, passed the stock Vite 8 criteria: embedded
heading, counter, `App.jsx` edit, manual reload, foreground Ctrl-C, prompt reuse and build. The
tuple, in the report's own labels, was `source935/browserguest/runtime100/program008`, with a stock
create-vite React template, Vite 8.3.5, `@vitejs/plugin-react` 6.1.2, 28 packages and dev port
5193. Two limits were recorded with it: the standalone `__preview/5193` tab returned HTTP 502
(left open and unattributed), and automatic HMR was not asserted; the edit passed by manual reload.

Evidence (local):

- `/work/reports/wave-20261029/waffle/vite8/935-consumer/RESULT.md`
- `/work/reports/wave-20261029/waffle/vite8/935-consumer/partA-gate/COMBINED-RESULT.md`
- `.../partA-gate/embedded-gate/RESULT.md` and `.../partA-gate/stop-build-targeted/RESULT.md`
- the earlier failing October 29 generation 12 run, which owns the installer, `parseEnv` and
  Rolldown thread-spawn history: `/work/reports/wave-20261029/waffle/vite8/RESULT.md`

So "Vite 8 never worked" is wrong. It worked at that identity, through the embedded preview.

### B. Public playground, November 2 (Browser-native engine)

`https://bun.sprockt.dev/playground/?mode=memory`, Chromium 156.0.8078.4, cross-origin isolated,
status `bun.wasm ready · Browser (native) · 18.7 MB`, guest Bun 1.4.4 (`16178d442`). Fixture: the
six files of `bun-wasm/sandbox/template`, Vite 8.3.5, plugin-react 6.1.2, React 19.3.1.

| Stage | Result |
| --- | --- |
| `bun install` | Pass, 24 packages in 19.881 s, including `rolldown` 1.2.16, `@rolldown/binding-wasm32-wasi` 1.2.16, `lightningcss-wasm` 1.33.0, `@napi-rs/wasm-runtime` 1.2.6 |
| Direct imports of `vite`, `rolldown`, `lightningcss`, the Rolldown binding, `@napi-rs/wasm-runtime` | Pass |
| `vite --host 127.0.0.1 --port 5173 --strictPort` | Printed `ready in 944 ms`, no error output |
| Standalone `__preview/5173/` | **HTTP 502** `No bun.wasm server is listening on port 5173.` |
| Counter, edit/HMR, reload | Not reached |
| `vite build` | Pass, `dist/index.html` plus one CSS and one JS asset |
| Positive control: `Bun.serve` on 5174, same context | HTTP 200 `control-ok` through the same preview router |

The probe checked only the standalone preview URL. It did not record whether the embedded frame
rendered. Evidence: `/work/reports/wave-20261102/vite8/FINDINGS.md` (second section) and
`/work/reports/wave-20261102/vite8/hello-world-20261102-public/` (`results.json`,
`bun-serve-control.json`, `fixture-files.sha256`, `cleanup.json`).

This is evidence about the public build, not local-dev acceptance, and it does not prove a Waffle
root cause. The working hypothesis is that a `node:http` server listening inside the guest is not
registered with the playground preview router the way `Bun.serve` is. That matches the open
standalone 502 from run A. It stays a hypothesis until stage 2 traces it.

### C. QuickJS vinext probe, November 2 (separate fixture)

bun-wasm probe tree at `dac56d02`, QuickJS producer `0b97916a`, local playground server, Cloudflare
vinext commit `db258404` pinned to vinext 1.4.0, Vite 8.3.4, plugin-react 6.1.0, React 19.3.1.
Install passed (80 packages). Dev and build both exited 1 before any listener with:

```text
error: Cannot find module '@rolldown/binding-wasm32-wasi' from '/home/user/node_modules/rolldown/dist/shared/binding-BMtuZhvP.mjs'
error: Unsupported architecture on Linux: wasm32
```

This is a package-selection failure at those pinned versions and that producer, not the run B
listener problem. Evidence: `/work/reports/wave-20261102/vite8/FINDINGS.md` (first section) and
`/work/reports/wave-20261102/vite8/vinext-quickjs-20261102-real-host/`.

### Worker history

A Vite 8 worker started on `lite/gpt-6-astra` on November 2 failed with `model_not_found` when
that account ended (local reference `/work/reports/wave-20261029/README.md`, 16:45 November 2
entry). It made no source change and no PR. No Vite 8 implementation worker has run since.

## Ownership

The fix may land in bun-wasm, Waffle or both. Decide only after the stage 2 trace.

| Area | Owner |
| --- | --- |
| `node:http` and `node:net` adapters, `Bun.serve`, the package installer's choice of the Rolldown WASM binding, emnapi and `@napi-rs/wasm-runtime` glue, the playground UI, its service worker and preview registration | Bun (bun-wasm) |
| `runtime.network()` listeners, `PreviewRouter`, preview host exchange and upgrade framing (`docs/preview.md`), processes, workers, WASI threads | Waffle |
| Generic shared memory, Atomics and Wasm transfer inside the JavaScript engines | Engines track |

Shared memory and threads: Waffle already has an approved threads lane,
[Native guest threads](wasi-threads.md), with stock thread fixtures and supervised waits on
main. It targets WASI Preview 1 commands and excludes emnapi and Node-API wrappers. Rolldown's WASM
binding imports shared memory and `wasi.thread-spawn` through `@napi-rs/wasm-runtime`. Run B built
successfully, so no thread change is currently indicated. If a thread or shared-memory gap appears,
hand it to that lane or the Engines track with the exact reproduction. Do not write a second thread
implementation here.

## Stages

### 1. Local reproduction and identity

- Create an exclusive bun-wasm worktree and record its commit, its Waffle pin, the guest build
  hash, the browser version and the engine.
- Build and serve the playground from that tree on an explicit free port: `cd web && bun install &&
  bun run build && bun run preview` (`BUN_WASM=<path>` selects another guest build).
- Copy the stock template (`bun-wasm/sandbox/template`) unchanged and run the run B commands:

  ```sh
  cd /home/user/vite8-probe
  bun install
  bun -e 'for (const name of ["vite", "rolldown", "lightningcss", "@rolldown/binding-wasm32-wasi", "@napi-rs/wasm-runtime"]) { try { await import(name); console.log("IMPORT_OK", name) } catch (error) { console.log("IMPORT_FAIL", name, error) } }'
  bun run dev
  bun run build
  ```

- Check both the embedded preview frame and the standalone `__preview/5173/` URL.
- Controls in the same browser context: `Bun.serve` on another port, and a minimal
  `node:http` `createServer().listen()` with no Vite. If `node:http` alone returns 502, the problem
  is the listener path, not Vite.
- Prefer extending bun-wasm's existing driver (`scripts/app-matrix/product-vite.ts`; the app matrix
  already has Vite 7 dev, HMR and build checks in `scripts/app-matrix/apps.mjs`) over writing a new
  one.

### 2. Trace the listener before choosing a fix

Follow one `node:http` `listen(5173)` from Bun's adapter to the point where `Bun.serve`
registers with the playground preview router, and from there through Waffle's `runtime.network()`
and `PreviewRouter`. Record where the two paths diverge and which repository owns that point. Also
explain why the embedded frame reached the server in run A while the standalone tab did not. Write
the result into this plan before stage 3.

### November 6 boundary trace and Waffle implementation

The two Waffle listen messages share one owning path. `NetHost.listen` in shared mode sends
`tcp-listen`; `NetHelper.executeTcp` calls `NetHelper.listen`, just as the asynchronous `listen`
message does. Successful namespace binding publishes `hooks.listening`. The bun-wasm adapter
`createBunNetworkHelper` forwards that event to the playground's `previews.register(port, helper)`.
Closing the listener or disposing its helper publishes `stopped`, which unregisters that exact
helper. A stale helper cannot unregister a replacement. None of these paths requires Vite policy.

The current consumer trace narrows the ready-then-502 failure to guest lifetime, not missing
Waffle registration. Its Vite 7 diagnostic records `tcp-listen` on 5173 at 52898.155 ms,
`listening` and registration at 52898.260 ms, `stopped` and unregister at 52913.205 ms, then worker
exit at 52926.620 ms. `Bun.serve` and minimal `node:http` controls both return 200 while still
running and registered. The consumer lane confirmed Vite closes its server on `process.stdin` end during noninteractive
execution. Setting `CI=true` keeps its Vite 7 diagnostic alive; desktop Chromium then renders React
and delivers an `App.tsx` edit while retaining counter state and recording zero navigations. This
does not establish Vite 8 acceptance or resolve the unrecorded embedded result from run B. The
failing trace is `/work/reports/wave-20261106/vite-react-hmr/listener-trace-initial.json`; the
subsequent passing trace is `listener-trace.json` beside it.

A separate Waffle bug was reproduced before its fix. Replacing a `PreviewRouter` server left the
old root relay open, and its dynamic connection lookup could reach the replacement listener.
`register` now closes and removes the old root binding when server identity changes. Registering
the same server preserves its binding. Regression tests cover active upgrade retirement, rejected
old HTTP and socket calls, a fresh replacement grant, and stale unregister calls. Independent
review also found that a throwing retirement callback stopped the cleanup loop. The coordinator
added failing-first tests with two live connections, drains close and notification callbacks
before reporting collected errors, and completes routing transitions despite retirement errors.
Replacement, unregister and rebind failure paths preserve a usable fresh grant.

`packages/waffle/tests/preview-vite.test.ts` runs the existing stock Vite 8.3.4 dependency with a
small vanilla TypeScript and CSS fixture, without a Vite plugin or application patch. A test-only
byte bridge connects a real `runtime.network()` shared listener to the native Vite server. It
checks dev HTML, the Vite client and transformed source through standalone mounted requests,
embedded root-relative requests, and a real loopback root host using the HTTP exchange protocol.
It builds the fixture, starts Vite preview, and checks the built HTML, JavaScript and CSS through
the same routes. Actual `vite-hmr` upgrade responses and connected frames pass through both the
mounted socket channel and root relay. Listener stop and helper teardown unregister the routes;
new requests return 502. The test asserts that preview work never activates process services.

This is native Vite protocol and Waffle transport proof. It is not guest Bun execution, a browser
React counter test, or real React source-edit HMR acceptance. The consumer lane owns those gates,
stock template install, stdin lifetime, and the separate Rolldown package-selection failure.

Reproduce from this exclusive worktree through the PC heavy runner:

```sh
NETWORK_SCRATCH_ROOT=/work/tmp bun test packages/waffle/tests/preview-vite.test.ts
bun test packages/waffle/tests/preview-host.test.ts packages/waffle/tests/preview-upgrade.test.ts packages/waffle/tests/preview-upgrade-lifetime.test.ts packages/waffle/tests/preview.test.ts
```

Both files are discovered by the package CI job's existing `bun run test`. No optional flag or
browser gate is required. Full browser acceptance stays in stages 4 and 5.

### 3. Fix at the owning layer

- Fix where the trace points, with a regression test that fails first: a `node:http` server is
  reachable through the standalone preview URL. Waffle tests live under `packages/waffle/tests/`
  (preview and network suites); bun-wasm preview tests live under `web/tests/`.
- Change both repositories together when the contract crosses them; no compatibility paths for
  the old shape. bun-wasm moves its Waffle pin in the same delivery.

### 4. HMR

Vite HMR uses a WebSocket. `docs/preview.md` records that raw upgrade bytes are tested but a native
WebSocket proxy and Vite HMR are not yet established. Prove the edit reaches the page without a
reload; if the upgrade path is missing, the owner is decided as in stage 2.

### 5. Finish-line run

Run the full finish line once, locally, in one uninterrupted run, and record identities, every
stage's output and the build file list. Run it on Chromium first, then Firefox and WebKit through
their existing runners.

### 6. vinext on QuickJS (follow-on)

After stage 5, check why the run C pins did not get `@rolldown/binding-wasm32-wasi` (installer
selection, lock contents or producer age). That is Bun installer work. Then rerun the unchanged
vinext fixture with `scripts/app-matrix/vinext-probe.ts`. vinext acceptance belongs to the Bun
track and is not part of this finish line.

## Tests and acceptance

- Each fix carries a focused unit or browser test in its own repository, plus that repository's
  standard checks (`AGENTS.md` "Verify" here).
- Acceptance is the stage 5 run, retained as a short result file with identities, the exact
  commands and their outputs. The owner can rerun it from those commands.

## Cleanup

Each run owns its teardown: the playground server, browser contexts and profiles, the guest
workspace, registry or cache copies and its worktrees. Heavy work goes through the PC heavy queue
or a fleet host per `.internal/owner-machine.md`. Keep only small results under `/work/reports/`.

## Open questions

1. Why does `node:http` fail where `Bun.serve` succeeds on the standalone preview URL, and which
   repository owns that point? **Historical public cause unconfirmed; current local build passes.**
   The November 6 trace established stdin-induced shutdown in a local noninteractive Vite 7
   diagnostic, not the exact cause of the historical November 2 public 502. On November 27, the
   current local `waffle` + `bun-wasm` build passed both standalone `__preview/<port>/` and
   embedded preview routes with HTTP 200 across Chromium, Firefox, and WebKit.
2. Did the embedded frame render in run B? **Unrecorded for run B; superseded by November 27
   acceptance**, where both the embedded preview frame (playground + `sandbox/dist`) and standalone
   preview pass across Chromium, Firefox, and WebKit.
3. Does the current local playground reproduce run B, or did the public build differ from current
   bun-wasm `main`? **Does not reproduce on current `main`** — current `waffle` (`e0250d6f5`) +
   `bun-wasm` (`2d6c0e5d8`) passes the complete stock Vite 8 React finish line with zero 502s.
4. Does the Vite HMR WebSocket upgrade work through the preview at all? **Yes on current `main`** —
   live `src/App.tsx` edits reach open pages via Vite HMR in 90–237 ms (`browser`) with 0
   navigations and counter state preserved across Chromium, Firefox, and WebKit.
5. Why did the vinext pins in run C miss the Rolldown WASM binding when run B's install got it?
   Remains a Bun-track follow-on outside this finish line.

## November 27 local finish-line acceptance and Tailwind v4 check

Verified locally against `waffle` `origin/main` (`e0250d6f5`, packed as `@waffle-os/runtime` /
`@waffle-os/relay`) wired into a local build of `bun-wasm` `origin/main` (`2d6c0e5d8`, CI run
`45931610802` guest binaries: `bun-browser.wasm`, `bun.wasm`, `quickjs.wasm`, `bun-tools.wasm`,
`shared-quickjs`, and `bash-web` shell guests).

### Stock Vite 8 React (`vite@8.3.5`, `@vitejs/plugin-react@6.1.2`, `react@19.3.1`, `rolldown@1.2.16`, `@rolldown/binding-wasm32-wasi@1.2.16`)

Unmodified `bun-wasm/sandbox/template` passed all finish-line stages (`bun install`, `vite` dev
ready, embedded preview frame + click, standalone `__preview/<port>/` load + click, live
`src/App.tsx` Vite HMR with 0 navigations and preserved counter state, manual reload, keyboard
`Control+c` stopping dev + unregistering port 5173 + usable prompt, and `vite build` emitting
nonempty `dist/index.html`, JS, and CSS):

| Browser | Engine (`profile`) | Total | HMR | Build CSS + JS |
| --- | --- | --- | --- | --- |
| Chromium 156.0.8078.4 | `browser` (`split`) | 9.6 s | 90 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |
| Firefox 157.0 | `browser` (`split`) | 17.3 s | 237 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |
| WebKit 27.2 | `browser` (`split`) | 14.1 s | 188 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |
| Chromium 156.0.8078.4 | `quickjs` (`shared-group`) | 18.6 s | 797 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |
| Firefox 157.0 | `quickjs` (`shared-group`) | 22.3 s | 989 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |
| WebKit 27.2 | `quickjs` (`shared-group`) | 19.2 s | 937 ms (0 navs, count preserved) | 555 B CSS, 219,992 B JS |

The `sandbox/dist` embedded preview UI also rendered and handled counter clicks across Chromium
(6.1 s), Firefox (9.6 s), and WebKit (8.7 s).

### Vite 8 + `@tailwindcss/vite` v4 (`4.3.5`)

Adding `tailwindcss@^4.1.0` and `@tailwindcss/vite@^4.1.0` installs cleanly (`tailwindcss@4.3.5`,
`@tailwindcss/vite@4.3.5`, `@tailwindcss/oxide@4.3.5`, `@tailwindcss/oxide-wasm32-wasi@4.3.5`),
and Tailwind's preflight CSS loads, **but zero utility classes are generated** across Chromium,
Firefox, and WebKit.

Root cause is strictly in `ShaulLavo/bun-wasm`, not Waffle:

- `@tailwindcss/oxide-wasm32-wasi` (Rust `std::fs::read_dir` / `wasi-libc` `opendir()`) calls
  WASI `path_open(dirfd=3, dirflags=1, path="home/user", oflags=O_DIRECTORY (2), ...,
  fsFlags=FDFLAG_NONBLOCK (4))`.
- `bun-wasm`'s `node:wasi` (`crates/bunwasm-runtime/generated/builtins/192.js:737-738`) translates
  `WASI_FDFLAG_NONBLOCK` to `O_NONBLOCK` (`2048`) and calls `fs.openSync(full, noflags)`.
- `bun-wasm`'s `crates/bunwasm-runtime/src/natives.rs:660-684` (`open_file`) validates flags
  against `supported = 3 | 64 | 128 | 512 | 1024 | 65536 | 131072 | 1052672`, which omits `2048`
  (`O_NONBLOCK`). It returns `ErrorKind::Unsupported` -> `ENOSYS (-38)` -> WASI errno `52`
  (`WASI_ENOSYS`). `@tailwindcss/oxide`'s `ignore::WalkBuilder` swallows the error and scans 0
  files.
- Waffle's own `path_open` (`packages/waffle/core/wasi.ts`, `packages/waffle/core/fd-reopen.ts`)
  already accepts `O_DIRECTORY | FDFLAG_NONBLOCK` and enumerates entries via `fd_readdir`
  (locked in by `packages/waffle/tests/wasi-path-open-metadata.test.ts`).
- Masking `O_NONBLOCK` in a diagnostic test-only `fs.openSync` wrapper shows no secondary
  Waffle or `bun-wasm` failure on the tested Linux desktop Playwright runs: full Vite 8 + React 19
  + `@tailwindcss/vite@4.3.5` dev styles, live HMR adding a new `text-rose-500` utility class
  (0 navigations, counter preserved), manual reload, Ctrl-C + prompt, and `vite build` (`5,643 B`
  CSS with `.flex`, `.bg-slate-900`, `.text-rose-500`) pass on Chromium (12.7 s), Firefox (18.5 s),
  and WebKit (17.2 s) with 0 console/page errors. Native macOS Safari and iOS Safari were not run
  for Tailwind v4.
- Separate iOS Safari note: `@tailwindcss/oxide-wasm32-wasi@4.3.5/tailwindcss-oxide.wasi.cjs`
  requests `new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true })` (1 GiB
  initial / 4 GiB max shared memory), which passes desktop browsers and Linux WebKit 27.2 but
  falls in the same 4 GiB shared-Wasm reservation class as Rolldown on iOS Safari.

Evidence archive: `/work/reports/a5-vite8-rolldown-20261127/RESULT.md`.
