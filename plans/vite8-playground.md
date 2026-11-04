# Vite 8 in the playground

Status: **Approved (owner, 2026-11-04). Preserved for later execution; this change implements
nothing.** No Vite build, probe or deployment ran while writing it.

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
   repository owns that point? (Stage 2.)
2. Did the embedded frame render in run B? It was not recorded.
3. Does the current local playground reproduce run B, or did the public build differ from current
   bun-wasm `main`?
4. Does the Vite HMR WebSocket upgrade work through the preview at all?
5. Why did the vinext pins in run C miss the Rolldown WASM binding when run B's install got it?
