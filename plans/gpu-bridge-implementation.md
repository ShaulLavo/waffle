# WebGPU bridge: implementation design

Status: **Approved and active (owner, 2026-11-02; active since 2026-11-06).** This is the
executable design for the [WebGPU bridge](gpu-bridge.md). Where the two disagree, this file wins
on module boundaries, wire encoding, slices and tests; the bridge plan keeps the decisions and
their reasons. Independent review comes before production code.

Prepared: 2026-11-06 on Waffle main
[`402fdafc`](https://github.com/ShaulLavo/waffle/commit/402fdafc). Design author: Claude (tech
lead role). Implementation: Sol lanes, one PR per slice.

## What exists today

Nothing GPU-related ships. No `runtime.display()`, no surface type, no `runtime_gpu` or
`runtime_window` import, no service. The pieces this design reuses are shipped and proven:

| Existing mechanism                                                                                                       | Where                                                                                        | Reused for                                 |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Lazy runtime capability: `runtime.network()` imports its module on first call and is disposed after physical stops       | `runtime.ts:694-720`, `runtime.ts:856-860`                                                   | `runtime.display()`                        |
| Per-launch owner `{ connection, dispose() }` passed to `launchWorker`, disposed by the broker on revocation, exit, error | `browser/preview1-network.ts`, `browser/process-broker.ts:1528-1560, 1681, 1807, 1821, 2045` | the graphics grant                         |
| Guest-side lazy import of an optional adapter only when the launch payload carries it                                    | `browser/worker.ts:1077-1080` (`preview1-socket.ts`)                                         | `runtime_gpu` and `runtime_window` imports |
| Port captured at bootstrap before guest code                                                                             | `browser/worker.ts:1171` `captureNetworkPort`                                                | the graphics port                          |
| Blocking guest wait in 10 ms slices with a liveness check                                                                | `browser/worker.ts:1162` `socketWait`                                                        | `open`, `append` and `completions` waits   |
| Dedicated page-owned service Worker that never runs guest code                                                           | `thread/service-worker.ts`, `thread/runtime-owner.ts:112`                                    | the GPU service Worker                     |
| Separate size gate with its own budget                                                                                   | `tooling/network-size.ts`                                                                    | `tooling/gpu-size.ts`                      |
| C fixture built once in the `libc` CI job with pinned wasi-sdk 34, uploaded and consumed by the `browser` job            | `.github/workflows/ci.yml:963-1055`, `scripts/build-memory-group-fixture.ts`                 | the GPU fixtures                           |

Issue [#286](https://github.com/ShaulLavo/waffle/issues/286) (WIT bindings) is still open. This
design uses handwritten imports, as both family plans allow. If #286 adopts WIT later, the imports
and their consumers change together; the stream records do not change.

### Engine probe, 2026-11-06

Run on the owner's PC (Linux) with Playwright 1.64.1's engines: a page transfers a canvas with
`transferControlToOffscreen()` to a dedicated worker, which requests an adapter and device,
configures a `webgpu` context, draws a triangle and calls `queue.writeBuffer` with a
`SharedArrayBuffer` view. Page served with COOP and COEP.

| Engine                                                               | `navigator.gpu` in worker | Adapter                                        | Triangle in page canvas                                                             | `writeBuffer` from SAB | `Atomics.waitAsync` |
| -------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- | ------------------- |
| Chromium 156.0.8078.4, no flags                                      | yes                       | none                                           | no                                                                                  | n/a                    | yes                 |
| Chromium 156, `--enable-unsafe-webgpu --enable-features=Vulkan` only | yes                       | SwiftShader, fallback                          | no: `requestDevice` failed ("A valid external Instance reference no longer exists") | n/a                    | yes                 |
| Chromium 156, SwiftShader flag set below                             | yes                       | SwiftShader (`google`/`swiftshader`, fallback) | **yes** (red on blue, `rgba8unorm`)                                                 | accepted               | yes                 |
| Firefox 157.0 with `dom.webgpu.enabled`                              | yes                       | none                                           | no                                                                                  | n/a                    | yes                 |
| WebKit 27.2 (Playwright, Linux)                                      | no                        | n/a                                            | no                                                                                  | n/a                    | yes                 |

The working Chromium flag set: `--enable-unsafe-webgpu --enable-features=Vulkan
--use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader
--disable-vulkan-surface`. G0.2 may minimize it. Consequence: **CI's blocking triangle gate is
Chromium with SwiftShader** in the existing `browser` job. Linux Firefox and WebKit run the
no-adapter and no-WebGPU paths, which are real behaviour worth gating. Real-GPU engines (Chrome,
Firefox and Safari on macOS, Safari on iPhone) are G0.3 manual runs on the owner's Mac and iPhone.

## Settled decisions

| Area                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service                  | One dedicated GPU service Worker per runtime (a plain `Worker`, not a browser ServiceWorker). Created on the first successful `runtime_gpu.open` of any process, never earlier. It owns every `GPUAdapter`, `GPUDevice` and canvas context. It never runs guest code.                                                                                                                                                                                      |
| Why not the guest        | A guest blocks in `Atomics.wait` and never returns to its event loop, so WebGPU promises and canvas commits cannot happen there ([bridge](gpu-bridge.md#why-a-separate-worker)).                                                                                                                                                                                                                                                                           |
| Page entry               | `await runtime.display()`, lazy like `runtime.network()`. The GPU lane builds the minimal display: surfaces, grants, resize tracking. Input, commands and winit stay in [guest windows](guest-windows.md) (its W0 adds the input ring to the same `Surface`).                                                                                                                                                                                              |
| Capability               | GPU access is a grant, not ambient. A launch carries a graphics grant `{ surfaces, gpu }`. Without one, `runtime_gpu` and `runtime_window` are not linked and a module importing them fails at link time with the existing unknown-import error.                                                                                                                                                                                                           |
| Grant transport          | Same shape as `Preview1Network`: `display.grant(...)` returns a single-launch owner `{ connection, dispose() }`; `launchWorker(context, { graphics })` moves ownership to the broker. Guest-spawned children inherit nothing. The generic spawn option `surfaces` from the windows plan comes with W1; the GPU lane does not change spawn requests.                                                                                                        |
| Connection               | Per process, up to 8 connections (one per `open`), each with its own adapter, device and handle tables. Connections never share objects.                                                                                                                                                                                                                                                                                                                   |
| Shared memory            | The **guest worker** allocates each connection's control block, command ring, completion ring and payload arena at `open` (captured constructors), and posts them over the port captured at bootstrap. Nothing is allocated for a granted process that never opens. A blocked guest cannot receive messages, so every service-to-guest result travels through these buffers.                                                                               |
| Canvas                   | `display.createSurface(canvas)` keeps the element. When a process holding the surface first opens a connection, the display owner calls `transferControlToOffscreen()` once and transfers the result to the service, where it stays until `surface.dispose()` or runtime disposal.                                                                                                                                                                         |
| Surfaces on the wire     | Surfaces are ordinary `webgpu.h` surface objects: `instance.create_surface` with a Waffle chained source naming the granted surface id. Configure, get-current-texture, present and unconfigure are the `webgpu.h` calls. No Waffle-only acquire or present records.                                                                                                                                                                                       |
| Pacing                   | Two frame slots per surface. `surface.get_current_texture` takes one; the display owner's page `requestAnimationFrame` loop (running only while some surface is configured) posts a tick to the service, which releases slots presented before the tick and emits `frame-slot` completions. A connection whose next record needs a slot stalls; others continue. Hidden tabs stop rAF, which stops rendering, as intended. One mechanism for every engine. |
| Stream                   | Generated from the pinned, vendored `webgpu.yml` plus Waffle's selection file. Binary, little-endian, whole records. Command encoders, passes and render bundles travel as one recorded blob.                                                                                                                                                                                                                                                              |
| Async in the guest's API | Tokens. A `webgpu.h` future maps to a token; `wgpuInstanceWaitAny` maps to blocking `completions`. Pipeline creation stays sync plus an error scope in the client ([bridge](gpu-bridge.md#stream-records)); the service never stalls replay on a guest-chosen handle except for `request_adapter` and `request_device`.                                                                                                                                    |
| Bad input                | Decoder faults (bad framing, unknown opcode, bad span, stale handle, generation that does not increase, unknown chained type) are protocol errors: that connection's devices are destroyed and it closes with reason `protocol`. A WebGPU call that throws during replay is not a protocol error: it becomes a `call-exception` completion and the result handle, if any, is marked invalid (contagious).                                                  |
| Kill                     | Revocation is immediate and needs no fence: the service holds no lock a guest can hold. On revocation the service destroys the process's devices, drops its tables, closes its rings and stops holding its surfaces. It does **not** call `unconfigure`, which replaces the canvas image with transparent black; the canvas keeps its last frame until the next holder configures it. G0.2 verifies this per engine.                                       |
| Ordering                 | One ordered command ring per connection. `append` takes the ring's writer lock, so threads of one process stay ordered even if a client forgets its own lock.                                                                                                                                                                                                                                                                                              |
| Loading                  | No static import edge from `core`, `fs`, `proc`, `runtime.ts`, `browser/worker.ts`, `browser/process-broker.ts` or `programs/` into `browser/display/` or `browser/gpu/`. Own size gate. Core budget unchanged.                                                                                                                                                                                                                                            |
| Versioning               | Additive imports and new exports: `waffleHostInterface` stays 1. No released family imports `runtime_gpu` before G5, so records may change freely until then. From G5 on, a changed record layout or removed opcode bumps it ([compatibility](../docs/host-abi.md#compatibility)).                                                                                                                                                                         |
| Threads                  | `launchThreadWorker` rejects a graphics grant, as it rejects `network` today. Threaded guests wait for threads S4 plus windows W5 and wgpu B3.                                                                                                                                                                                                                                                                                                             |

## Module layout

All new code is TypeScript under `packages/waffle/`, except fixtures (C) and data (JSON, YAML).

| Path                                                                              | Realm                 | Role                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/display/owner.ts`                                                        | page (trusted)        | `RuntimeDisplay`, `Surface`, `GraphicsGrant`; holder table; ResizeObserver; rAF tick; activates and disposes the service; relays `open` after grant checks; diagnostics hook for tests. |
| `browser/display/protocol.ts`                                                     | shared types          | `GraphicsConnection` launch payload, page-to-service messages, surface info block layout. Type-only for guest and broker imports.                                                       |
| `browser/display/guest.ts`                                                        | guest (enforced)      | `runtime_window` subset: `surfaces`, `surface_info`.                                                                                                                                    |
| `browser/gpu/guest.ts`                                                            | guest (enforced)      | `runtime_gpu`: `open`, `append`, `completions`, `payload`, `close`.                                                                                                                     |
| `browser/gpu/ring.ts`                                                             | guest and service     | Ring header layout, reserve, publish, consume. No WebGPU. Payload copies use captured helpers.                                                                                          |
| `browser/gpu/service-worker.ts`                                                   | service entry         | Message loop, connection registry, rAF ticks, revocation, disposal.                                                                                                                     |
| `browser/gpu/service.ts`                                                          | service               | Connection state, handle tables, open and close, protocol-error isolation, completions writer, payload arena allocator.                                                                 |
| `browser/gpu/scheduler.ts`                                                        | service               | Ready queue, round robin, per-slice budgets, yield.                                                                                                                                     |
| `browser/gpu/replay.ts`                                                           | service               | Table-driven decoder that calls an injected `GpuTarget` (the real `GPU` in the service; a recording fake in unit tests).                                                                |
| `browser/gpu/surfaces.ts`                                                         | service               | OffscreenCanvas contexts, holders, frame slots.                                                                                                                                         |
| `browser/gpu/stream.json`                                                         | data                  | Waffle's selection of `webgpu.h` calls with explicit opcodes, Waffle records, completion kinds, chained types, enum name overrides. Hand-edited.                                        |
| `browser/gpu/upstream/webgpu.yml`, `LICENSE`                                      | data                  | Exact bytes of webgpu-headers at the pinned revision and its BSD-3-Clause license.                                                                                                      |
| `browser/gpu/generated/tables.ts`                                                 | generated, checked in | Decoder tables: per opcode, receiver type, argument layout program, JS method, descriptor builder steps; enum value to JS string maps.                                                  |
| `tooling/gpu-stream.ts`                                                           | tooling               | Generator. `--check` regenerates in memory and fails on any difference or on opcode rule violations.                                                                                    |
| `tooling/gpu-size.ts`                                                             | tooling               | Budgets for the page display chunk, guest imports chunk and service bundle.                                                                                                             |
| `tooling/gpu-measure.ts`                                                          | tooling               | G0.3 and G4 measurement page and synthetic streams; prepares a portable directory for the Mac like `workspace-safari-runner.ts --relay-prepare`.                                        |
| `scripts/build-gpu-fixture.ts`                                                    | tooling               | Builds the C fixtures with `WASI_SDK_PATH`; `--verify` like the memory group fixture.                                                                                                   |
| `tests/fixtures/gpu/`                                                             | fixtures              | `triangle.c`, later `scene.c`, `readback.c`, `stress.c`; generated `waffle_gpu_stream.h`; hand-written `gpu_encode.h` helpers.                                                          |
| `tests/gpu-*.test.ts`, `tests/gpu-browser-runner.ts`, `tests/gpu-browser-page.ts` | tests                 | Unit and browser suites.                                                                                                                                                                |

Package exports added: `./browser/display` (owner, page API) and `./browser/gpu/service-worker`
(entry URL), each with the usual `types`/`node`/`bun`/`browser`/`default` conditions. The service
Worker URL is resolved with `new URL("../gpu/service-worker.ts", import.meta.url)` inside
`owner.ts`, as `programs/collection.ts:328` does for the Preview 1 worker.

Private authority: `browser/display/guest.ts`, `browser/gpu/guest.ts` and `browser/gpu/ring.ts`
join `enforcedModules` in `tooling/private-authority.ts`. Rings, control blocks, the payload arena,
the port and the connection map are private authority: captured `Atomics`, typed-array
constructors, `SharedArrayBuffer` constructor and `Reflect.apply` for `postMessage`, indexed loops,
no iteration of private collections. `browser/display/owner.ts` joins `trustedModules` as a
page-only module. Service modules are not guest-realm code; the lazy-loading test proves the guest
bootstrap never reaches them.

## Page API

```ts
const display = await runtime.display();
const surface = display.createSurface(canvas); // keeps the element; no transfer yet
runtime.registerAdapter("app", async (context, service) =>
  service.launchWorker(context, {
    workerUrl: preview1WorkerUrl,
    request: { module: context.module, args: context.request.argv, env: context.request.env },
    graphics: display.grant({ surfaces: [surface], gpu: true }),
  }),
);
surface.dispose(); // revokes its holder's use, releases the OffscreenCanvas in the service
```

- `display.grant({ surfaces, gpu })` validates synchronously: each surface belongs to this display,
  is not disposed and has no holder (else throws `DOMException` `InvalidStateError` with
  "surface is held"). It records the grant as holder and returns `{ connection, dispose() }`.
  `dispose()` is idempotent; the broker calls it at revocation, exit, worker error and failed
  launch, exactly where it calls `disposeNetwork` today.
- `gpu: false` grants surfaces only (for the windows lane). `surfaces: []` with `gpu: true`
  grants compute without canvases.
- `display.dispose()` runs inside `runtime.dispose()` after physical stops, beside the network
  owner: revoke every grant, post `dispose` to the service (it destroys every device), terminate
  the service Worker, disconnect observers, stop rAF. A disposed display rejects new grants.
- `runtime.display()` never activates processes, the filesystem service beyond what the runtime
  already did, or the network, and creates no Worker.

### Launch payload

```ts
interface GraphicsConnection {
  readonly port: MessagePort; // page end stays in the display owner
  readonly gpu: boolean;
  readonly surfaces: readonly { readonly id: number; readonly info: SharedArrayBuffer }[];
  readonly limits: { readonly commandBytes: number; readonly payloadMaxBytes: number };
}
```

`info` is a 32-byte block per surface written by the page: `i32 seq` (seqlock, odd while
writing), `u32 width`, `u32 height` (physical pixels), `u32 scale_milli`, `u32 flags` (bit 0
visible, bit 1 focused; more bits belong to the windows lane). The owner writes it on
ResizeObserver callbacks (`devicePixelContentBoxSize` where available, else content box ×
`devicePixelRatio`, rounded) and on visibility change. Defaults: `commandBytes` 4 MiB (power of
two, 64 KiB to 64 MiB), `payloadMaxBytes` 64 MiB.

`RuntimeWorkerRequest.graphics?: GraphicsConnection`; the broker pushes `graphics.port` onto the
transfer list next to the network port. Bootstrap captures the port and links
`runtime_window` when `surfaces.length > 0` and `runtime_gpu` when `gpu`, by dynamically importing
`browser/display/guest.ts` and `browser/gpu/guest.ts` only in that case.

## Guest ABI

All addresses are guest addresses; output records are little-endian. Results are `0`, a count, or
a negative WASI errno: `-EBADF` (-8) unknown connection or surface, `-EINVAL` (-28) bad span,
framing or flags, `-ENOBUFS` (-42) the next completion does not fit, `-ENOMEM` (-48) a ring or
arena could not be allocated or admitted, `-ENOTSUP` (-58) no `navigator.gpu` in the service realm,
`-EPIPE` (-64) the connection is closed, revoked or failed, `-EMFILE` (-33) more than 8 connections.

### `runtime_window` (subset; the windows plan owns the rest)

```text
surfaces(out_ptr, out_len) -> count              granted surface ids, u32 each; count may exceed what fits
surface_info(id, out{width, height, scale_milli, flags}) -> 0
```

These are the handwritten forms from [guest windows](guest-windows.md#guest-abi-runtime_window),
unchanged. `events_read`, `wake`, `command` and `clipboard_read` arrive with W0 and W1.

### `runtime_gpu`

```text
open(flags, out{conn}) -> 0
append(conn, ptr, len) -> 0
completions(conn, buf_ptr, buf_len, timeout_ns: i64, out{written}) -> 0
payload(conn, handle, dst_ptr, len) -> 0
close(conn) -> 0
```

- **open.** `flags` must be 0. The import allocates, with captured constructors: a 64-byte control
  block, the command ring (`commandBytes` + 64-byte header), a 256 KiB completion ring and the
  payload arena (growable `SharedArrayBuffer`, initial 1 MiB, max `payloadMaxBytes`). It posts
  `{ type: "open", conn, control, commands, completions, payload }` on the captured port, then
  waits on `control[0]` in 10 ms slices with `checkActive`. The page owner checks the grant is
  live, admits the bytes against the runtime's shared memory reservations (G3; G0.2 skips
  admission), activates the service if needed, transfers any not-yet-transferred granted
  canvases, and relays the message. The service writes `1` (ready) or a negative errno to
  `control[0]` and notifies. `out{conn}` is a small per-process integer chosen by the import.
- **append.** Accepts one or more whole records: walks the headers in guest memory, requires each
  length to be at least 8, a multiple of 8, and their sum to equal `len`, else `-EINVAL` with
  nothing written. Takes the ring writer lock, copies records, splits any record longer than
  half the ring into chunk records (the client never chunks), waits for space in 10 ms slices with
  `checkActive` and a state check, publishes the head after each batch and notifies the service.
  Returns `-EPIPE` once the ring state is not open.
- **completions.** Copies whole completion records into the buffer. With none available it waits
  until one arrives, the deadline passes (negative waits forever, 0 polls) or the connection
  closes. A first record larger than `buf_len` returns `-ENOBUFS` with nothing consumed. After the
  connection closes, remaining records are still delivered, and only then is `-EPIPE` returned.
- **payload.** Copies a payload named by a completion (`mapped`, `compilation-info`) into guest
  memory, `len` must equal its length, then frees it. Each handle is copied at most once; unknown
  or already copied handles return `-EINVAL`.
- **close.** Sets the ring state to closed and notifies; returns without waiting. The service then
  destroys the connection's devices and releases everything.

## Shared memory layouts

Command and completion rings share one layout: a 64-byte header of `Int32` words, then a
power-of-two data area.

| Word      | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| 0 `head`  | Bytes published by the producer, as a wrapping u32 counter.                                   |
| 1 `tail`  | Bytes consumed, wrapping u32. Free space = capacity − (head − tail).                          |
| 2 `lock`  | Writer lock (command ring only): 0 free, 1 held; `compareExchange`, waiters park on it.       |
| 3 `state` | 0 open, 1 closed by guest, 2 revoked, 3 protocol error, 4 service failed, 5 runtime disposed. |
| 4 `wake`  | Incremented on every state change, so a waiter on `head` or `tail` can also wake on close.    |

Records are 8-byte aligned and never wrap: if the space to the end of the data area is too small,
the producer writes a pad record (opcode 0, or completion kind 0) to the end first. Producers
publish `head` with `Atomics.store` only after the bytes are written, so a killed producer can
never expose a partial record.

The payload arena is a growable `SharedArrayBuffer` used as a ring of slots
(`u32 length, u32 state, bytes`, 8-byte aligned). The service appends slots and grows the buffer up
to its maximum when full; a slot that can never fit fails its completion with status
`payload-too-large` (the client maps smaller ranges). The guest marks a slot copied; the
service's tail skips forward over copied slots in order. Handles are slot sequence numbers.

## Stream schema and generator

### Source

- `browser/gpu/upstream/webgpu.yml`: exact bytes of
  [`webgpu.yml`](https://github.com/webgpu-native/webgpu-headers/blob/a1dc77409bb2b8bd80540cbf4b8db219e123e909/webgpu.yml)
  at webgpu-native/webgpu-headers `a1dc77409bb2b8bd80540cbf4b8db219e123e909` (2026-09-29, "Add
  atomic_vec2u_min_max (#604)"), 5,532 lines, SHA-256
  `9268864efc29edc2e4fa40949643d14ae5bf6664447eadfccdeaefe7e14d130b`, BSD-3-Clause. It describes
  23 objects with 146 methods; eight are asynchronous (`instance.request_adapter`,
  `adapter.request_device`, `buffer.map_async`, `device.create_compute_pipeline_async`,
  `device.create_render_pipeline_async`, `device.pop_error_scope`,
  `queue.on_submitted_work_done`, `shader_module.get_compilation_info`).
- `browser/gpu/stream.json`: `upstream` (repository, revision, SHA-256), `commands`
  (`{ "opcode": n, "call": "object.method" }`), `waffle` records, `completions`, `chained`
  allowlist with sType values, `enumNames` overrides, `retired` opcodes.
- The generator parses YAML with `Bun.YAML.parse` (Bun 1.4.4 has it), checks the upstream hash,
  and resolves each selected call's arguments and structs from the YAML. Getters and other calls
  that only read cached state (`get_limits`, `get_features`, `has_feature`, `get_info`,
  `get_mapped_range`, texture size getters, `get_preferred_canvas_format`, surface
  `get_capabilities`) are not stream records; clients answer them from completions.

Opcode rules, enforced by `--check`: unique; `0` is pad; `0x0001`–`0x0fff` are `webgpu.h` calls;
`0x1000`–`0x1fff` are Waffle records; a removed opcode moves to `retired` and is never reused.

### Encoding rules

Record header, 8 bytes: `u16 opcode, u16 flags, u32 length` (whole record, multiple of 8). Flag
bit 0 marks a chunk with more to follow, bit 1 the last chunk; any other bit is a protocol error.

Body, in this order: result handles for calls that return objects; a `u32 token` plus 4 bytes of
padding for asynchronous calls (the callback-info argument is not encoded); the receiver handle
(omitted inside recorded blobs); then the YAML arguments in order. Types:

| YAML type                                                 | Wire                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bool`                                                    | u32, 0 or 1, else protocol error                                                                     |
| `uint16`, `int16`, `uint32`, `int32`, `float32`, `enum.*` | 4 bytes (16-bit widened); enums carry `webgpu.h` numeric values                                      |
| `uint64`, `int64`, `float64`, `usize`, `bitflag.*`        | 8 bytes, aligned to 8 from the record start (bitflags are 64-bit in `webgpu.h`)                      |
| `object.*`                                                | `u32 id, u32 generation`; `(0, 0)` is null and allowed only where the YAML marks the member optional |
| string types (`WGPUStringView`)                           | `u32 length` (`0xffffffff` = null) and UTF-8 bytes, padded to 4                                      |
| `struct.*` by value                                       | members inline, in YAML order                                                                        |
| optional struct pointer                                   | `u32 present`, then the struct if 1                                                                  |
| `array<T>`                                                | `u32 count`, padding to 8 when `T` has 8-byte fields, elements                                       |
| `c_void` data with its size argument                      | `u32 length`, bytes padded to 8; replaces the size argument                                          |
| `nextInChain`                                             | `u32 count`, then per link `u32 sType` and its struct; only allowlisted sTypes                       |

Sentinels such as `WGPU_WHOLE_SIZE`, `WGPU_LIMIT_U32_UNDEFINED` and `WGPU_COPY_STRIDE_UNDEFINED`,
and enum value `undefined`, become an omitted member in the JavaScript dictionary.

Enum values map to WebGPU strings by snake case to kebab case, plus `enumNames` overrides where the
WebGPU IDL differs (texture and vertex formats such as `rgba8_unorm_srgb` → `rgba8unorm-srgb`). A
unit test checks the result against the GPUTextureFormat, GPUVertexFormat and other enum value
lists copied from the WebGPU specification into `tests/fixtures/gpu/webgpu-idl-enums.json` with
their source revision.

### Waffle records and blobs

| Opcode   | Record                | Body                                                                                                                                            |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x1000` | `release`             | `u32 object type, u32 pad, handle`                                                                                                              |
| `0x1001` | `encode`              | result command-buffer handle, optional `command_encoder_descriptor`, `u32 length`, padding, nested records ending with `command_encoder.finish` |
| `0x1002` | `render-bundle`       | result render-bundle handle, `render_bundle_encoder_descriptor`, nested records ending with `render_bundle_encoder.finish`                      |
| `0x1003` | `buffer-unmap-writes` | buffer handle, `u32 count`, per range `u64 offset, u32 length, pad, bytes` (G2, shadow writes)                                                  |

Inside a blob, records use the ordinary opcodes of `command_encoder`, `render_pass_encoder`,
`compute_pass_encoder` or `render_bundle_encoder` methods without a receiver handle. A
`begin_render_pass` or `begin_compute_pass` opens a pass that must close with its `end` before
another pass or `finish`. Nested `encode` is a protocol error. Draw records are 24 bytes.

The Waffle chained sType `SurfaceSourceWaffle` (body `u32 surface id, u32 pad`) is the only
chained type of `instance.create_surface`. Its value `0x7ffe0001` sits outside the prefixes
webgpu-headers assigns to implementations and is recorded in `stream.json`. Registering a prefix
upstream is not needed.

### Completion records

Header, 16 bytes: `u16 kind, u16 flags, u32 length, u32 token, i32 status`. Kinds and bodies are
defined in `stream.json` with the same type vocabulary:

| Kind               | Body                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`          | adapter handle bound or status `unavailable`; `adapter_info`, features (`webgpu.h` values), `limits`, preferred canvas format, WGSL language features |
| `device`           | features and limits granted, or status and message                                                                                                    |
| `mapped`           | payload handle and length, or status                                                                                                                  |
| `work-done`        | none                                                                                                                                                  |
| `error-scope`      | error type and message, or none                                                                                                                       |
| `compilation-info` | payload handle                                                                                                                                        |
| `uncaptured-error` | device handle, type, message (truncated at 4 KiB, flag bit 0)                                                                                         |
| `device-lost`      | device handle, reason (`destroyed`, `unknown`, `protocol`, `revoked`, `service`), message                                                             |
| `call-exception`   | opcode, result handle or null, message                                                                                                                |
| `frame-slot`       | surface handle                                                                                                                                        |
| `surface-lost`     | surface handle (surface disposed by the page)                                                                                                         |
| `closed`           | reason; always last                                                                                                                                   |

### Generated outputs

- `browser/gpu/generated/tables.ts`: checked in, so source-only consumers need no generation step.
- `tests/fixtures/gpu/waffle_gpu_stream.h`: opcode, flag, completion and sType constants, and
  record layout comments for the C fixtures. It is a fixture header, not a client library.
- Rust and C clients outside this repository generate their own encoders from `stream.json` and
  the vendored YAML at a pinned Waffle commit.

### Mapping for a C `webgpu.h` client

Every stream record is a `webgpu.h` call or one of four Waffle records, numeric enum values are the
header's own, futures are tokens, `wgpuInstanceWaitAny` is `completions` with a timeout, and
`wgpuInstanceProcessEvents` is `completions` with timeout 0. A future C implementation is a
mechanical encoder plus a cache of adapter and device completions. G1's acceptance checks that the
C fixtures use nothing but the generated header and these rules.

## Service execution

- **Connections.** The service keys connections by `(grant id, conn)`. Each holds tables per
  object type (id → object and generation), the adapter and device it requested, pending tokens,
  and its rings. Table capacity is capped at 2^20 ids per type; going above is a protocol error.
  A handle must be created with a generation greater than the last one for that id.
- **Replay.** `replay.ts` interprets the generated layout programs over a `DataView` of the ring.
  Each call goes to an injected `GpuTarget`. `queue.write_buffer` and `queue.write_texture` pass a
  view straight into the ring (Chromium accepts SAB views; the probe confirmed it). At service
  start the service tests once whether its engine accepts a SAB view and otherwise copies through
  a reused scratch `ArrayBuffer`. Chunked records are reassembled into a scratch buffer first.
- **Async.** `request_adapter` and `request_device` stall only their own connection until they
  resolve, because later records name the result. Every other asynchronous call attaches a
  continuation that writes a completion and lets replay continue in order.
- **Errors.** WebGPU validation errors stay inside WebGPU and surface through error scopes and
  `uncapturederror`, as on the web. Synchronous exceptions become `call-exception`; a later record
  that names an invalid handle is skipped and reported the same way.
- **Scheduler.** Each connection waits with `Atomics.waitAsync` on its ring head and joins the
  ready queue when woken. One slice runs one connection until any of: 4 ms of replay, 1 MiB of
  records, a `surface.present`, an empty ring, or a stall. The service then publishes the tail,
  notifies blocked appenders, requeues the connection if it has more, and yields to the event loop
  through a `MessageChannel` message before the next slice, so canvas commits and page messages run
  between connections. Budgets are constants in `scheduler.ts`; G0.3 and G4 tune them.
- **Frame slots.** `surface.get_current_texture` binds the guest's texture handle to
  `context.getCurrentTexture()` and takes a slot; with none free the connection stalls.
  `surface.present` marks the frame presented and ends the slice. The page rAF tick releases slots
  of frames presented before it and writes `frame-slot` completions.
- **Revocation.** `revoke(grant)` from the page: for each connection, set state `revoked`, bump
  `wake` and notify both rings, `device.destroy()` each device, drop tables, forget the rings, and
  remove the grant as holder of its surfaces (configured contexts stay as they are, see Kill).
- **Service failure.** A Worker `error` closes every connection with reason `service` and marks
  transferred surfaces lost. The next `open` starts a fresh service; lost surfaces report
  `surface-lost` and the embedder creates new canvases. This is generic failure handling, not a
  restart path for version mismatch.

## Lazy loading proof

1. **Static graph test** (`tests/gpu-lazy-loading.test.ts`, Bun): `Bun.build` with `splitting:
   true` for `runtime.ts`, `browser/preview1-worker.ts`, `browser/process-broker.ts`, `core/index.ts`,
   `fs/index.ts` and `proc/index.ts`. Each entry chunk must not contain the marker strings exported
   by `browser/display/owner.ts`, `browser/gpu/guest.ts` and `browser/gpu/service.ts`; the
   `runtime.ts` build must contain them in a separate chunk (proves the dynamic edge exists).
2. **Size gates.** `bun run size` prints the same core bytes as before the change and stays inside
   `CORE_BUDGET_BYTES`. `bun run size:gpu` checks the three GPU bundles against their budgets,
   set from the first measurement plus 10 to 15 percent.
3. **Browser observation** (in `tests/gpu-browser-runner.ts`, every engine): the page wraps
   `Worker` and records `performance.getEntriesByType("resource")`. Cases: a filesystem-only page
   and a page that spawns a non-graphics Preview 1 program load no `display` or `gpu` module and
   create no extra Worker; `runtime.display()` plus `createSurface` plus `grant` loads only the
   display chunk, creates no Worker and does not load `proc/` modules; the first `open` creates
   exactly one service Worker; a second process's `open` creates none.

## Delivery slices

Each slice is one PR with its own tests, independent review and merge. Nothing claims a release
before G5, and G5 cannot start before G3 and the G0.3 measurements are done.

| Slice                            | Effort                     | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Exit gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0.1** Schema and replay core  | 2–3 days                   | Vendored YAML and license, `stream.json` with the triangle subset (`instance.request_adapter`, `instance.create_surface`, `adapter.request_device`, `device.get_queue`, `device.create_shader_module` with `ShaderSourceWGSL`, `device.create_render_pipeline`, `device.destroy`, `texture.create_view`, `surface.configure`, `surface.get_current_texture`, `surface.present`, `command_encoder.begin_render_pass`, `render_pass_encoder.set_pipeline`, `render_pass_encoder.draw`, `render_pass_encoder.end`, `command_encoder.finish`, `queue.submit`, `release`, `encode`), completions `adapter`, `device`, `call-exception`, `frame-slot`, `device-lost`, `closed`; generator and `--check`; `ring.ts`; `replay.ts` with a recording fake target. | `bun run quality` (includes `gpu-stream --check`); `bun test packages/waffle/tests/gpu-stream.test.ts packages/waffle/tests/gpu-ring.test.ts packages/waffle/tests/gpu-replay.test.ts`: encoding round trips for every selected call, enum name test, ring wrap and pad, writer-lock ordering across two Bun Workers, partial-record invisibility, a seeded fuzz of 10,000 mutated triangle streams that only ever ends in a clean protocol error, never an exception escaping the decoder.                                                                                                                                                  |
| **G0.2** First triangle          | 4–6 days                   | `runtime.display()`, `Surface`, `grant`, launch payload, broker ownership, bootstrap linking, `runtime_window` subset, `runtime_gpu`, service Worker with scheduler and surfaces, revocation, disposal, diagnostics hook (`gpuDiagnostics(display)`: connections, devices, objects per type). `tests/fixtures/gpu/triangle.c`, `scripts/build-gpu-fixture.ts`, browser runner, CI wiring, `tooling/gpu-size.ts`.                                                                                                                                                                                                                                                                                                                                        | Browser runner in CI: Chromium draws the triangle (center red, corners blue) and a second process redraws the same canvas green after the first exits; Firefox reports `adapter` with status `unavailable`; WebKit `open` returns `-ENOTSUP`; kill while blocked in `open`, in `completions` and between `get_current_texture` and `present` leaves the diagnostics tables empty and the next process drawing; malformed stream from one process ends only its connection with `device-lost` `protocol`; lazy-loading cases; `bun run size`, `size:gpu`, `quality`, `test`. Records whether the canvas kept its last frame after revocation. |
| **G0.3** Measurements            | 2–3 days, parallel with G1 | `tooling/gpu-measure.ts` page and portable directory for the Mac. Runs on Chrome, Firefox and Safari on macOS and on the iPhone, following the [bridge's G0 list](gpu-bridge.md#delivery-slices-and-effort): light-guest frame time under a 20,000–50,000 draw flood with and without caps, replay cost per draw, service startup and memory, device count on iOS, last frame after revocation, `transferToImageBitmap` at 1080p and 4K, `waitAsync` wake latency, SAB views in `writeBuffer`.                                                                                                                                                                                                                                                          | Results and engine versions written into this plan. A failure of the one-service topology goes to the owner as a decision before G3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **G1** Protocol and core         | 6–9 days                   | Every creation, queue, encoder, pass, bundle and query call from `webgpu.yml` except the excluded list; chunking; bind groups and layouts; textures, samplers, depth; `scene.c` (textured, depth-tested, bind groups, render bundle).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Chromium CI renders `scene.c` matching a reference image within tolerance; a coverage test lists every YAML method as selected, client-cached or excluded with a reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **G2** Async results             | 5–8 days                   | Payload arena, `buffer.map_async` reads, shadow writes with `MAP_WRITE` mapped to `COPY_DST \| COPY_SRC` and `mappedAtCreation` handled by the client, error scopes, compilation info, work done, uncaptured errors, device loss. `readback.c`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Chromium CI: readback of the rendered scene matches; error scope returns the expected validation error; compilation info lists a deliberate WGSL error; `device.destroy` yields `device-lost` `destroyed`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **G3** Ownership, kill, fairness | 4–6 days                   | Full kill matrix (during `open`, blocked in `completions`, mid-`append` with a full ring, mid-frame, during a pending map), memory admission of rings and arena against runtime reservations (`-ENOMEM`), fairness under a flood, `surface.dispose()` while held, runtime disposal ordering, service failure.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Browser runner cases for each; a flood connection cannot stop a light connection from presenting at least once per 100 ms in Chromium (threshold revised by G0.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **G4** Throughput                | 4–8 days                   | Synthetic Horizon-sized stream (thousands of draws, megabytes of uploads per frame) generated from `stream.json`; per-engine frame time, copy cost, ring size. Decision on direct guest-memory reads for threaded guests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Numbers in this plan; ring default updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G5** Release                   | 3–5 days                   | `docs/host-abi.md` section, `docs/architecture.md`, `docs/status.md`, troubleshooting for missing WebGPU, public page for `runtime.display()`; `waffleHostInterface` rule applies from here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Docs review; G0.3 evidence for every engine claimed as supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

G0.1 through G3 total about 23–35 engineer-days, close to the bridge plan's estimate. The wgpu
backend's B0 can start once G1 merges.

## First triangle: the exact path

1. Build the fixture on the PC (small; no heavy runner needed):
   `WASI_SDK_PATH=/work/cache/wasi-sdk-34.0-x86_64-linux bun packages/waffle/scripts/build-gpu-fixture.ts /work/tmp/gpu-fixture-<lane>`.
   It compiles `triangle.c` for `wasm32-wasip1` with `-O2` and no threads.
2. Run `GPU_FIXTURE_DIR=/work/tmp/gpu-fixture-<lane> PROCESS_SCRATCH_ROOT=/work/tmp bun packages/waffle/tests/gpu-browser-runner.ts chromium firefox webkit`.
   The runner owns its loopback server (COOP and COEP headers), browser and profile; Chromium
   gets the SwiftShader flag set.
3. The page creates the runtime, a 64×64 canvas, `runtime.display()`, a surface, registers
   `/bin/gpu-triangle` with an adapter whose launcher passes `display.grant({ surfaces: [surface],
   gpu: true })`, and spawns it with a pipe on stdin.
4. `triangle.c`: `surfaces` → one id; `surface_info` → 64×64; `open`; append
   `instance.request_adapter`; `completions` until `adapter` (prints the adapter architecture);
   `adapter.request_device`; `completions` until `device`; one `append` with `device.get_queue`,
   `instance.create_surface` (`SurfaceSourceWaffle`), `device.create_shader_module`,
   `device.create_render_pipeline` (auto layout), `surface.configure` (preferred format from the
   adapter completion, `RENDER_ATTACHMENT`, 64×64, opaque), `surface.get_current_texture`,
   `texture.create_view`, `encode` (clear blue, set pipeline, draw 3, end, finish), `queue.submit`,
   `surface.present`; `completions` until `frame-slot`; prints `frame`; reads stdin to EOF;
   `close`; exits 0.
5. On `frame` the runner screenshots the canvas and checks the pixels, closes stdin, waits for
   exit 0, screenshots again and records whether the frame survived revocation, then reads
   `gpuDiagnostics` and expects zero connections and objects.
6. CI: `libc` job builds the fixture next to the memory group fixture (cache key on
   `tests/fixtures/gpu/**` and the build script) and uploads it; `browser` job downloads it and
   `scripts/test-browser.ts` runs the GPU runner in the parallel group (Chromium plus Firefox) and
   WebKit in the serial group. The `changes` filter adds `packages/waffle/browser/{display,gpu}/**`,
   `tests/fixtures/gpu/**` and the GPU tests and tooling to the `browser` output; update
   `tooling/ci-paths.test.ts`.

## Engine capabilities

| Capability                                                            | Needed by                | Chromium                                   | Firefox                                                         | Safari / WebKit                                                   |
| --------------------------------------------------------------------- | ------------------------ | ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `crossOriginIsolated`, `SharedArrayBuffer`, `Atomics.wait` in workers | guest (already required) | yes                                        | yes                                                             | yes                                                               |
| `navigator.gpu` in a dedicated worker                                 | service                  | yes (Linux CI needs the SwiftShader flags) | macOS Apple Silicon from 147, Windows; Linux 157 had no adapter | Safari 26 macOS and iOS per BCD; Playwright Linux WebKit has none |
| OffscreenCanvas `webgpu` context from `transferControlToOffscreen`    | service                  | yes (probe)                                | BCD lists Windows only: G0.3 checks macOS                       | Safari 26 per BCD: G0.3 checks                                    |
| `Atomics.waitAsync`                                                   | service                  | 90+                                        | 145+                                                            | 16.4+                                                             |
| Growable `SharedArrayBuffer`                                          | payload arena            | yes                                        | yes                                                             | yes (already used by the filesystem)                              |
| `writeBuffer` from a SAB view                                         | zero-copy uploads        | yes (probe)                                | G0.3                                                            | G0.3; copy fallback otherwise                                     |
| `ResizeObserver` `devicePixelContentBoxSize`                          | surface info             | yes                                        | yes                                                             | no: content box × `devicePixelRatio`                              |
| Page `requestAnimationFrame`                                          | frame slots              | yes                                        | yes                                                             | yes                                                               |

## Attribution

- `browser/gpu/upstream/webgpu.yml` and `LICENSE`: **License copy** row in `docs/bun-patches.md`
  with repository, revision `a1dc77409bb2b8bd80540cbf4b8db219e123e909`, SHA-256 and BSD-3-Clause.
- `browser/gpu/stream.json`, `generated/tables.ts`, `tests/fixtures/gpu/waffle_gpu_stream.h`:
  **Adaptation** row: derived mechanically from that file (names, argument order, enum values);
  Waffle's selection, opcodes, encoding and records are original.
- `tests/fixtures/gpu/webgpu-idl-enums.json`: **Adaptation** row: enum value lists from the W3C
  WebGPU specification (`gpuweb/gpuweb` `spec/index.bs` at the revision used), under the W3C
  Software and Document License.
- Everything else (`browser/display/`, `browser/gpu/` services, ring, scheduler, replay, fixtures):
  **Original adapter** rows. Dawn Wire, Firefox's WebGPU IPC and WebKit's RemoteGPU informed the
  design ([prior art](gpu-bridge.md#prior-art)); no code is copied from them. If an implementer
  adapts code from emdawnwebgpu's `library_webgpu.js` (Dawn, BSD-3-Clause) or wgpu's
  `backend/webgpu.rs` (MIT or Apache-2.0) for descriptor mapping, that file gets its own
  Adaptation row with path and revision in the same PR.

## Changes from the bridge plan

- The guest allocates rings at `open`; the plan left allocation open.
- Canvases transfer when a holding process first opens, not on the first surface record, so replay
  never waits for the page.
- Surfaces are `webgpu.h` surface objects created with a Waffle chained source, so acquire and
  present are the standard calls, not Waffle records.
- Frame slots are released by a page rAF tick in every engine.
- Revocation destroys devices but does not unconfigure, to keep the last frame.
- `payload` needs `len` equal to the payload length; `-ENOBUFS` and `-EMFILE` are added.
- The GPU lane builds the minimal display (`runtime.display()`, surfaces, grants and the
  `surfaces`/`surface_info` imports) that the windows plan's W0 and W1 extend.

## Owner decisions

1. **Name of the guest-crates repository** ([guest graphics](guest-graphics.md#open-questions-for-the-owner)),
   suggested `waffle-rs`. It blocks only the wgpu backend's B0, not any slice here.
2. **If G0.3 shows one service cannot keep up**, the fallback (per-process workers rendering
   offscreen and sending frames to page canvases) is a topology change for the owner to approve.

Everything else above is settled for implementation.
