# WebGPU bridge for blocking guests

Status: **Proposed plan. Nothing here is implemented.** The page-side service is TypeScript and
needs no new Rust exception. Its Rust client, the [wgpu backend](wgpu-backend.md), needs
[ADR 006 (proposed)](guest-graphics.md#adr-006-proposed-rust-guest-crates).

Prepared: 2026-10-31. Inspected Waffle baseline
[`9b66e3aa2462771f65ca263745a23c80e2c8fea3`](https://github.com/ShaulLavo/waffle/commit/9b66e3aa2462771f65ca263745a23c80e2c8fea3),
wgpu `30.0.1` from crates.io, and Horizon
[`4e833c2fe6cfec9698cff687ded95208e8871061`](https://github.com/horizon-rust/horizon/commit/4e833c2fe6cfec9698cff687ded95208e8871061)
as the first consumer. Estimates are engineering judgments; no browser numbers are measured yet.

Part of the [guest graphics](guest-graphics.md) family, alongside
[windows and input](guest-windows.md) and the [wgpu backend](wgpu-backend.md).

## Goal and supported boundary

Give WASI Preview 1 guests WebGPU. A guest encodes WebGPU calls into a byte stream; a
page-owned **GPU service** worker replays them against a real `GPUDevice` and draws into canvases
granted through [`runtime.display()`](guest-windows.md#page-api-typescript). Results that WebGPU
delivers through promises (adapter, device, buffer mapping, error scopes, compilation info, work
done, device loss) come back to the guest, which blocks in `Atomics.wait` when it needs one.

The stream speaks **WebGPU, not wgpu**. Opcodes and records follow the WebGPU IDL, so the same
service can later serve a C `webgpu.h` implementation or another Rust client. The
[wgpu backend](wgpu-backend.md) is the first client.

Out of scope: WebGL fallback, WebGPU in the page's own JavaScript, sharing GPU objects between
processes, video frame import (`importExternalTexture`), and WebXR.

## Why a separate worker

A guest blocks in `Atomics.wait` and never returns to its worker's event loop while it runs.
WebGPU resolves `requestAdapter`, `requestDevice`, `mapAsync`, `popErrorScope`,
`onSubmittedWorkDone` and `getCompilationInfo` through promises, which need that event loop.
An OffscreenCanvas also presents only when its worker's task ends. So the device cannot live in
the guest's worker. This is the rule [concepts](../docs/concepts.md#why-guests-block) already
states for the network helper: whatever serves a blocked guest runs on another, responsive thread.

JSPI could suspend a guest on a promise, but it is not available in every engine and does not
compose with `wasi-threads`. Not used.

## Recommended decisions

| Area             | Decision                                                                                                                                                                  | Reason / cost                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service shape    | One GPU service worker per runtime, created lazily on the first `runtime_gpu.open` or GPU surface use. It owns every adapter, device and canvas context.                  | Same ownership as the filesystem worker. A device and the canvases it renders to must share one realm, and a process may draw to several surfaces. |
| Canvas ownership | `display.createSurface` transfers the OffscreenCanvas to the GPU service on first GPU use. It stays there until `surface.dispose()`.                                      | `transferControlToOffscreen` works once per element. Tying the canvas to a process worker would kill the canvas with the process.                  |
| Identity         | Guest-allocated `u32` ids per object type. `release(id)` on drop. The service keeps per-connection tables.                                                                | Creation needs no round trip, so almost every call is one-way.                                                                                     |
| Stream           | Binary, little-endian, whole commands. Command encoders, render passes, compute passes and render bundles are recorded in the guest and sent as one blob at `finish()`.   | Thousands of draws per frame cross the boundary as one copy. Resource creation and queue calls stay in the ordered stream.                         |
| Ordering         | One ordered stream per connection. Multi-producer ring with an atomic reservation; the client serializes appends under its own lock.                                      | Matches guest happens-before. Per-thread lanes could not order a `createBuffer` on one thread before a `submit` on another.                        |
| Async results    | Every async operation carries a guest token. Results arrive as completion records; large payloads (mapped bytes) sit in a payload area copied on demand.                  | One mechanism for replies and callbacks. The client decides which waits block.                                                                     |
| Pacing           | `getCurrentTexture` reserves one of two frame slots per surface; the display module's `requestAnimationFrame` tick releases them.                                         | Bounds latency and memory without the guest knowing about rAF. Hidden tabs stop releasing slots, which stops rendering.                            |
| Bad input        | An unknown id, out-of-range span or malformed command is a protocol error: the service destroys that connection's devices and reports device loss with reason `protocol`. | WebGPU validation handles legal-but-wrong calls. Malformed streams from a guest must never reach the page or other processes.                      |
| Loading          | Separate chunk and gzip budget in `tooling/runtime-size.ts`. No effect on core, filesystem or process bundles.                                                            | Pay for what you use.                                                                                                                              |

## Canvas and surface ownership

- `display.createSurface(canvas)` keeps the element. On the first GPU request for that surface the
  display module calls `canvas.transferControlToOffscreen()` and transfers the result to the GPU
  service with the surface id.
- A connection may configure a surface only while its process holds that surface's grant
  ([grants](guest-windows.md#recommended-decisions)). On revocation the service unconfigures the
  context, destroys the process's devices and releases its ids. The canvas keeps its last frame
  until the next holder configures it.
- `surface.dispose()` releases the OffscreenCanvas in the service. The element cannot be reused for
  WebGPU afterwards; the embedder creates a new one.
- Canvas size: the guest's `configure` sets `width` and `height` on the OffscreenCanvas from the
  sizes delivered in `resize` records, in physical pixels.

## Guest ABI: `runtime_gpu`

Results are `0`, a count, or a negative WASI errno: `-EBADF` for an unknown connection, `-EINVAL`
for a bad span, `-ENOTSUP` when the browser has no WebGPU, `-EPIPE` after the connection's devices
were lost to a protocol error.

```text
open(flags, out{conn}) -> 0
    Activates the service if needed and blocks until it answers. Fails with -ENOTSUP without
    navigator.gpu in the service realm.
append(conn, ptr, len) -> 0
    Copies whole commands into the connection's ring. Blocks while the ring is full.
    Commands become visible to the service in append order.
completions(conn, buf_ptr, buf_len, timeout_ns: i64, out{written}) -> 0
    Copies whole completion records. Blocks until at least one, the deadline, or close.
    A negative timeout waits forever; 0 polls.
payload(conn, handle, dst_ptr, len) -> 0
    Copies a completion's payload (mapped bytes, compilation messages) into guest memory and
    frees it. Each handle is copied at most once.
close(conn) -> 0
    Releases every id and device of the connection. Drop of the last client object calls it.
```

The commands themselves are data, not imports, so adding a WebGPU call adds an opcode and needs no
new import or link change. Opcode additions do not bump `waffleHostInterface`; a changed record
layout or removed opcode does ([compatibility](../docs/host-abi.md#compatibility)).

### Stream records

Header: `u16 opcode, u16 flags, u32 length`. Ids are `u32`. Descriptors encode WebGPU dictionary
members in IDL order, with a presence bitmask for optional members; strings and labels are
length-prefixed UTF-8. The opcode table is generated from one TypeScript source that also emits
the Rust encoder's constants, so the two sides cannot drift.

Groups (each a short range of opcodes):

- **Adapter and device:** `request-adapter(token, options)`, `request-device(token, adapter, descriptor)`,
  `device-destroy`, `push-error-scope`, `pop-error-scope(token)`.
- **Creation:** buffer, texture, texture view, sampler, bind group layout, pipeline layout, bind
  group, shader module (WGSL source), render and compute pipelines (sync form only; async creation
  is done by the guest as sync creation plus an error scope), query set, render bundle.
- **Buffers:** `map(token, buffer, mode, offset, size)`, `unmap(buffer, write ranges)`, where
  write ranges carry the bytes the guest wrote into its shadow copy.
- **Queue:** `write-buffer(buffer, offset, bytes)`, `write-texture(copy, layout, size, bytes)`,
  `copy-external-image` (unsupported in the first release), `submit(command buffer ids)`,
  `on-submitted-work-done(token)`.
- **Recorded command buffer:** `command-buffer(id, encoder blob)`. The blob holds encoder,
  render-pass and compute-pass commands in WebGPU order, including `multi-draw-indirect`
  expansions done by the service rather than the guest.
- **Surface:** `configure(surface, device, format, usage, alpha mode, view formats)`,
  `unconfigure`, `acquire(surface, texture id)`, `present(surface)`.
- **Lifetime:** `release(type, id)`.

### Completion records

`u16 kind, u16 flags, u32 token, …`. Kinds: `adapter` (info, features, limits, format
capabilities for the formats a client asks about, WGSL language features), `device` (granted
features and limits, or failure), `mapped` (payload handle, or failure), `work-done`,
`error-scope` (type and message, or none), `compilation-info` (payload handle),
`uncaptured-error`, `device-lost` (reason, message), `frame-slot` (surface, released slot).

## Service execution

- The service waits on each connection's ring with `Atomics.waitAsync` and runs commands in a
  task. After a task that executed a `present`, it returns to the event loop so the browser
  commits the frame. It caps work per task so one connection cannot starve another, and visits
  connections round-robin.
- `acquire(surface, id)` binds the guest's chosen texture id to `context.getCurrentTexture()` for
  that frame. The id is invalid after `present`.
- Error scopes: the service pushes and pops real WebGPU error scopes in stream order and returns
  the popped result as a completion, so `pop-error-scope` is as accurate as on the web.
- `uncapturederror` and `device.lost` become completion records. The client decides what to do
  with them.
- Map reads: the service awaits `mapAsync`, copies the range into the payload area, unmaps, and
  posts `mapped`. Map writes need no service map at all: the guest writes into a shadow copy and
  `unmap` carries the bytes, which the service applies with `queue.writeBuffer`. This also covers
  `mappedAtCreation`.

## Memory and copies

The first release copies data twice: guest memory to ring (in the `append` import, inside the
guest's worker) and ring to WebGPU (`writeBuffer`/`writeTexture`). Mesh uploads in a game like
Horizon move tens of megabytes per second while streaming terrain, so the ring defaults to 16 MiB
per connection, sized in the [measurement slice](#delivery-slices-and-effort).

A later, measured optimization lets the service read upload bytes straight from the guest's shared
memory for `wasm32-wasip1-threads` guests, whose memory is already a `SharedArrayBuffer` owned by
the process controller in [guest threads](wasi-threads.md). That needs: WebGPU accepting
`SharedArrayBuffer`-backed views in `writeBuffer` in every target engine (verify, do not assume),
the guest keeping the source range alive until the write's sequence number is reached, and the
process controller lending the memory to the service under the same revocation fences as
filesystem connections. Decide after measurement, not before.

## Browser support

The service needs `navigator.gpu` in a dedicated worker and a WebGPU context on an
OffscreenCanvas. Shipping status changes quickly; record exact versions in slice G0 instead of
copying them from here. Known gaps to check first: Firefox outside Windows and macOS, WebGPU on
Linux generally, and iOS memory limits.

CI today runs Playwright Chromium, Firefox and WebKit on Linux. Linux WebKit and Firefox likely
have no WebGPU there. G0 decides whether CI can run Chromium with a software adapter
(SwiftShader) and which engines are covered manually on the owner's Mac and iPhone through the
existing `tooling/workspace-safari-runner.ts` route.

## Delivery slices and effort

| Slice                  | Rough effort | Deliverable and exit gate                                                                                                                                                                                                                       |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0. Proof              | 4–6 days     | Hand-encoded stream from a single-threaded `wasm32-wasip1` C or Rust fixture draws a triangle into a granted canvas through a minimal service. Record engine versions, software-adapter CI result, and per-frame overhead of an empty frame.    |
| G1. Protocol and core  | 8–12 days    | Generated opcode table (TS and Rust constants), id tables, creation calls, recorded command buffers, queue writes, configure/acquire/present, frame slots. A fixture renders a textured, depth-tested scene with bind groups.                   |
| G2. Async results      | 5–8 days     | Adapter and device negotiation, map reads with payloads, shadow writes, error scopes, compilation info, work done, uncaptured errors, device loss.                                                                                              |
| G3. Ownership and kill | 4–6 days     | Grants checked on configure, revocation at every process outcome, protocol-error isolation, fairness across connections, runtime disposal ordering, size budget. A kill during `append`, `completions` and mid-frame leaves the service usable. |
| G4. Measurement        | 5–10 days    | Replay a captured Horizon-sized frame stream (thousands of draws, megabytes of uploads) and measure frame time, copy cost and ring sizing per engine. Decide on direct guest-memory reads.                                                      |
| G5. Release            | 4–6 days     | Browser qualification, public host ABI and architecture docs, status page, troubleshooting entries for missing WebGPU.                                                                                                                          |

G0–G3 total **21–32 engineer-days**; through G5, **30–48**. G0–G3 need neither thread support nor
the wgpu backend: fixtures can hand-encode streams. The wgpu backend can start against G1.

## Acceptance

- Kills at every stage (during `open`, while blocked in `completions`, mid-`append`, between
  `acquire` and `present`) leave other processes' devices and canvases working and release every
  GPU object of the killed process.
- A malformed stream ends only its own connection, with a `device-lost` reason `protocol`.
- An ordinary filesystem-only page and a process-only page fetch nothing from the GPU chunk; the
  core budget is unchanged.
- Private authority: the ring, payload area and device objects never pass through a
  guest-mutable builtin ([private authority](../docs/private-authority.md)).
- A frame with a few thousand draws stays within budget in the target engines (number set in G4).

## Risks

- **Throughput.** Unknown until G4. If double copies dominate, direct reads from guest memory are
  the main lever, and they depend on the threads plan.
- **WGSL dialect drift.** Guests that produce WGSL with naga can emit constructs a browser's
  compiler rejects. The service reports them through compilation info and error scopes; fixes go
  into the client or upstream naga.
- **Feature gaps.** Native-only wgpu features (polygon mode, push constants, mappable primary
  buffers, many texture formats) do not exist in WebGPU. Clients must treat adapter features as
  authoritative.
- **Service stall.** One GPU service serves every process. A guest that submits enormous frames
  slows others. Round-robin caps bound it; a per-process service is the fallback if measurement
  demands it.
