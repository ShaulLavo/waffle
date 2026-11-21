# WIT surface experiment

**Decision for [#286](https://github.com/ShaulLavo/waffle/issues/286). Defer the Microsoft host adapter.**
Stock Rust bindings worked in Waffle's ordinary Preview 1 worker. Microsoft's generated TypeScript
removed manual Canonical ABI record layout and handle lookup. The pinned browser package needed an
initialization patch and added about 21 KiB gzip for three imports. Revisit when a smaller
synchronous host adapter can reuse the same wire and pass the guest-worker authority checks.

## What ran

The page owns one Waffle runtime, its process broker, a real worker-backed filesystem, and one
canvas. The Rust command reads a file through WASI Preview 1 before it touches the surface.
The page grants the existing canvas with `gpu: false`. The fixture extends the existing GPU
fixture worker through its namespace and initialization hooks. Waffle instantiates the module,
binds its memory, runs `_start`, and retires the worker. Microsoft supplies the generated import
functions. Its instance loader and worker connection factories are unused.

The WIT resource represents a borrow from the page's grant. Fallible `acquire(id)` returns at most
one live handle per process. The method returns a copied, seqlock-consistent record. The adapter
keeps the grant and revocation cell outside the Microsoft package and passes it only guest memory,
plain records, and numeric handles. The fixture runs core Wasm only. The Microsoft runtime uses
mutable JavaScript builtins and needs its own authority review before use with guest JavaScript.

The current upstream `wasi-gfx:surface@0.2.0` constructs a surface, exposes width and height as
separate methods, permits size requests, and emits input and resize streams. The experiment
starts with a page-owned surface, reads a combined record with scale and flags, and omits event
imports. [Upstream surface WIT](https://github.com/wasi-gfx/wasi-gfx/blob/24615bbdf06f5a55ea6506db4596ed24072d3a6e/packages/surface/wit/surface.wit)

## The wire and lifetime

`wasm-tools print` checks the stock Rust core module imports. All three are in
`waffle:experiment/window`. The generated TypeScript import adapter linked those exact names and
signatures to the live guest.

| Import | Core parameters | Result in guest memory |
| --- | --- | --- |
| `acquire` | `i32 id, i32 out` | 8 bytes. An option tag at offset 0 and a handle at offset 4. |
| `[method]surface.info` | `i32 handle, i32 out` | 20 bytes. An option tag and four little-endian 32-bit fields at offsets 4 through 16. |
| `[resource-drop]surface` | `i32 handle` | None. |

The Rust guest and its handwritten comparison both read `320 × 200` initially and `448 × 256`
twice after the page changes the canvas. Both reject an ID outside the grant. The generated guest
drops and reacquires the resource on the original grant, then drops it again. A live handle returns
no record once the page revokes the grant. The guest can still drop that handle and cannot
reacquire the revoked surface.

The raw Wasm controls use a dropped handle after successful reacquisition. Both a stale method
and a double drop trap with an unknown-handle error. A missing import fails startup after
the adapter initializes and before it issues a handle. On ordinary exit without Rust drop and on
SIGKILL at the stdin barrier, the worker's finish hook removes the outstanding handle.
Each case checks zero remaining handles where applicable, grant retirement, worker termination,
and process collection. An unrelated Preview 1 process stays alive through revocation,
retirement and cancellation, then reads its byte and exits successfully.

## Reproduce

Use Rust 1.98.1 with the `wasm32-wasip1` target and edition 2024, wit-bindgen 0.57.1,
wasm-tools 1.262.0, Bun 1.4.4, Node 26.12.1 and npm 11.20.0. The two Rust builds share
one source and compiler profile. Playwright 1.64.1 and its browser versions come from the Waffle
lockfile. The runner uses `curl`, `tar` and `patch` to prepare Microsoft's pinned source in scratch.
It compiles with the upstream lockfile's TypeScript 6.0.3.

```sh
bun install --frozen-lockfile
# Put wasm-tools 1.262.0 on PATH or set WASM_TOOLS to its absolute path.
# On the owner's PC, use the heavy runner for the browser command.
bun /work/heavy-runner/current/run.js --host local --class browser waffle-286-surface -- \
  bun .internal/wit-surface/run.ts chromium firefox webkit
```

The generator package is `@vscode/wasm-component-model` 1.0.2 at Microsoft revision
`7585d3902cad4948f2f8852006d3714b2a9afb1f`. Its CLI fails before it reads WIT because the pinned
yargs 18 import has no `parserConfiguration` method. The runner passes
`wasm-tools component wit --json` output to the generator's unchanged `processDocument` export.
The stock browser entry also fails with `No runtime abstraction layer installed`. The scratch
patch makes its two connection imports lazy. [Microsoft generator and runtime source](https://github.com/microsoft/vscode-wasm/tree/7585d3902cad4948f2f8852006d3714b2a9afb1f/wasm-component-model)

The handwritten path requires the Rust target and the existing Waffle browser bundle. The WIT
experiment adds the Rust macro crate, wasm-tools, and Microsoft's generator and host runtime.
Node, npm, TypeScript, yargs and semver are build tools. The optional browser chunk carries
Microsoft's runtime and the generated TypeScript. The fixed records use caller-provided return
storage. Microsoft's default memory object requires the guest's `cabi_realloc` export, though the
raw stale-handle control supplies a trapping allocator and proves these calls never invoke it.

## Measured cost

The production entry has no dependency on the experiment. The fixture also checks its ordinary
page and worker build graphs and confirms the ordinary and handwritten commands request no WIT
guest binary or adapter chunk. They produce no adapter evaluation signal.

| Artifact | Bytes | Gzip bytes |
| --- | ---: | ---: |
| Generated TypeScript | 5,288 | 1,344 |
| Optional minified browser chunk | 93,604 | 21,929 |
| Preview 1 guest using generated bindings | 69,356 | 28,252 |
| Preview 1 guest using handwritten bindings | 68,503 | 27,784 |
| Guest delta | 853 | 468 |

Each benchmark runs seven batches of 100,000 `info` calls and checks the accumulated width.
Results are medians in microseconds per call on the owner's Linux PC under ordinary load.

| Playwright engine | Handwritten | Generated |
| --- | ---: | ---: |
| Chromium 156.0.8078.4 | 5.85 | 0.69 |
| Firefox 157.0 | 4.17 | 0.56 |
| WebKit 27.2 | 2.07 | 0.80 |

Both paths make one synchronous Wasm-to-JavaScript call per read and use Waffle's shared snapshot
reader. The timing measures the whole import path. The existing handwritten wrapper validates the
guest span by probing for shared memory, while the generated wrapper writes via its Canonical ABI
memory range. These timings cannot isolate the cost of generated lowering from the cost of the
different wrappers.

The fixture covers one private-memory worker and one surface-only grant. Thread sharing, native
Safari, start-section imports before an exported memory can be bound, input events, and WebGPU
are outside this proof.
