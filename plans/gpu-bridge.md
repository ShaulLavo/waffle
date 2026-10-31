# WebGPU bridge for blocking guests

Status: **Proposed plan. Nothing here is implemented.** The page-side service is TypeScript. Its
Rust client, the [wgpu backend](wgpu-backend.md), lives outside this repository
([where the code lives](guest-graphics.md#where-the-code-lives)).

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

The stream speaks **WebGPU, not wgpu**. Records are generated from `webgpu.yml`, the
machine-readable source of the C `webgpu.h` ([wire format](#wire-format)), so the same service can
later serve a C `webgpu.h` implementation or another Rust client. Keeping that possible is a
requirement ([decided](guest-graphics.md#decided)). The
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

## Prior art

Researched 2026-10-31. Every browser engine already solves a version of this problem: an untrusted
client that cannot own the GPU sends WebGPU work to a shared owner.

| System                                                                                                           | Topology                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What we take                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | What we leave                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome with [Dawn Wire](https://github.com/google/dawn/blob/main/include/dawn/wire/Wire.h)                       | One [GPU process per browser](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/) serves every renderer through shared-memory [command buffers](https://www.chromium.org/developers/design-documents/gpu-command-buffer/), assuming "the client can go rogue".                                                                                                                                                                                                                                   | Client-allocated `(id, generation)` handles with reuse and a server check that generations only increase ([ObjectStore](https://dawn.googlesource.com/dawn/+/b88aeebd804be770bba9d5bc8d55c9ff63eefd6d/src/dawn/wire/client/ObjectStore.cpp)); futures for async calls and return commands for callbacks ([dawn_wire.json](https://github.com/google/dawn/blob/main/src/dawn/dawn_wire.json)); `unregister` to free; chunked commands for oversized writes; cooperative yielding in the scheduler. | Its bytes. Opcodes are generated enum positions with no version field, tied to one Dawn build, one record per draw, and no JavaScript server exists.                                                                                                |
| Firefox                                                                                                          | Content processes talk to a `WebGPUParent` in the compositor process ([PWebGPU.ipdl](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/webgpu/ipc/PWebGPU.ipdl)); one id space per client; batched messages.                                                                                                                                                                                                                                                                                                             | Client-side ids from [wgpu-core-remote](https://github.com/gfx-rs/wgpu/blob/trunk/wgpu-core-remote/src/hub.rs) to avoid round trips; **contagious invalidity**: a failed creation makes its id an error object, not a protocol fault; IPC types that cannot express native-only features. Batching mattered: early Firefox WebGPU was slow from unbuffered IPC ([bug 1878035](https://bugzilla.mozilla.org/show_bug.cgi?id=1878035)).                                                             | bincode encoding, which is Rust- and serde-specific.                                                                                                                                                                                                |
| Safari / WebKit                                                                                                  | One [GPU process](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/GPU/GPUProcessProxy.cpp); each client gets its own work queue and object heap ([RemoteGPU](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/GPUProcess/graphics/WebGPU/RemoteGPU.cpp)) and a 2 MiB shared-memory stream with client-made identifiers ([RemoteGPUProxy](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/GPU/graphics/WebGPU/RemoteGPUProxy.cpp)). `requestAdapter` and `getMappedRange` block the client. | The closest match to Waffle: shared owner, ring per client, blocking waits.                                                                                                                                                                                                                                                                                                                                                                                                                       | Per-client threads; a worker cannot make them, so Waffle time-slices instead.                                                                                                                                                                       |
| Emscripten                                                                                                       | Pins a canvas to the thread that creates its context ([settings](https://github.com/emscripten-core/emscripten/blob/main/src/settings.js)); `OFFSCREEN_FRAMEBUFFER` with proxying lets many threads share one context at a latency cost ([html5.h](https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/api_reference/html5.h.rst)).                                                                                                                                                                                  | Confirms the trade-off: pin the context to one owner, proxy everyone else.                                                                                                                                                                                                                                                                                                                                                                                                                        | emdawnwebgpu calls WebGPU in the calling thread and cannot block without Asyncify ([library_webgpu.js](https://github.com/google/dawn/blob/main/third_party/emdawnwebgpu/pkg/webgpu/src/library_webgpu.js)), which is the problem this plan solves. |
| [`wasi:webgpu`](https://github.com/WebAssembly/wasi-webgpu) and [wasi-gfx](https://github.com/wasi-gfx/wasi-gfx) | Component Model resources mirroring WebGPU, with Preview 3 async and copy-based mapping; surfaces and input in `wasi-gfx:surface`. The browser [shim](https://github.com/wasi-gfx/wasi-gfx-shim) runs in the same realm, with no remoting.                                                                                                                                                                                                                                                                                                | Copy-based mapping, which matches our shadow buffers; a `webgpu.h` over it exists ([wasi-webgpu-headers](https://github.com/wasi-gfx/wasi-webgpu-headers)). A component adapter could later lower `wasi:webgpu` calls into this stream.                                                                                                                                                                                                                                                           | As an ABI now: it needs the canonical ABI and Preview 3 async, and its handles come from the host.                                                                                                                                                  |

Facts from the specifications that decide the topology:

- An `OffscreenCanvas` can move between workers only while it has no context. After `getContext`
  it is pinned to that realm for good, and `transferControlToOffscreen()` fails once the element
  has a context ([HTML](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)).
- A `GPUDevice` cannot be shared across workers; WebGPU multithreading is future work
  ([spec](https://github.com/gpuweb/gpuweb/blob/main/spec/index.bs)).
- For WebGPU, `transferToImageBitmap()` is a move without a copy, so a worker can render into its
  own OffscreenCanvas and hand frames to a page-owned `bitmaprenderer` canvas.
- `writeBuffer` and `writeTexture` take `AllowSharedBufferSource`, so reading uploads from a
  `SharedArrayBuffer` is allowed by the spec.

**Conclusion: one GPU service per runtime, with one isolated connection per process.** A canvas
outlives the processes that draw to it only if the worker that called `getContext` outlives them;
a per-process worker would strand the canvas at the first kill. All three browsers run one shared
GPU owner with per-client state. GPU work ends up in the browser's single GPU process regardless,
so the only contention Waffle controls is JavaScript replay time, which per-task caps handle.
Slice G0 confirms this with the measurements listed there. If measurement shows one worker cannot
keep up, the fallback keeps canvases page-owned: per-process workers render into their own
OffscreenCanvas and send frames through `transferToImageBitmap()` to `bitmaprenderer` canvases.

## Recommended decisions

| Area             | Decision                                                                                                                                                                                                                                                                                                                                                                                      | Reason / cost                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service shape    | One GPU service worker per runtime, created lazily on the first `runtime_gpu.open` or GPU surface use. Each process gets an isolated connection with its own adapters, devices and handle tables.                                                                                                                                                                                             | Matches every browser engine ([prior art](#prior-art)). A canvas is pinned to the worker that first calls `getContext`, so only a worker that outlives processes can hand a canvas to the next one. |
| Canvas ownership | `display.createSurface` transfers the OffscreenCanvas to the GPU service before any context exists. The service calls `getContext("webgpu")` once and keeps that context until `surface.dispose()`.                                                                                                                                                                                           | `transferControlToOffscreen` works once per element, and `getContext` pins the canvas to the calling worker.                                                                                        |
| Identity         | Guest-allocated `(id, generation)` handles per object type, as in Dawn Wire. `release` on drop. Per-connection tables.                                                                                                                                                                                                                                                                        | Creation needs no round trip, so almost every call is one-way. Generations catch use after release.                                                                                                 |
| Stream           | Binary, little-endian, whole commands. Command encoders, render passes, compute passes and render bundles are recorded in the guest and sent as one blob at `finish()`.                                                                                                                                                                                                                       | Thousands of draws per frame cross the boundary as one copy. Resource creation and queue calls stay in the ordered stream.                                                                          |
| Ordering         | One ordered stream per connection. Multi-producer ring with an atomic reservation; the client serializes appends under its own lock.                                                                                                                                                                                                                                                          | Matches guest happens-before. Per-thread lanes could not order a `createBuffer` on one thread before a `submit` on another.                                                                         |
| Async results    | Every async operation carries a guest token. Results arrive as completion records; large payloads (mapped bytes) sit in a payload area copied on demand.                                                                                                                                                                                                                                      | One mechanism for replies and callbacks. The client decides which waits block.                                                                                                                      |
| Pacing           | `getCurrentTexture` reserves one of two frame slots per surface; the display module's `requestAnimationFrame` tick releases them.                                                                                                                                                                                                                                                             | Bounds latency and memory without the guest knowing about rAF. Hidden tabs stop releasing slots, which stops rendering.                                                                             |
| Bad input        | A failed creation is not a protocol error: its handle becomes an error object and WebGPU reports the failure through error scopes (contagious invalidity, as in Firefox). Malformed bytes, unknown opcodes, bad spans, stale handles and generations that do not increase are protocol errors: the service destroys that connection's devices and reports device loss with reason `protocol`. | Legal-but-wrong calls behave as they do on the web. Malformed streams from a guest never reach the page or other processes.                                                                         |
| Loading          | Separate chunk and gzip budget in `tooling/runtime-size.ts`. No effect on core, filesystem or process bundles.                                                                                                                                                                                                                                                                                | Pay for what you use.                                                                                                                                                                               |

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

## Wire format

### Source of truth

Records are generated from webgpu-headers' [`webgpu.yml`](https://github.com/webgpu-native/webgpu-headers),
the machine-readable description of the stable C `webgpu.h`. Waffle checks in one data file
derived from a pinned `webgpu.yml` revision plus Waffle's own records (acquire, present, chunking,
release, recorded command buffers). A generator turns it into the service's decoder tables; clients
generate their encoders from the same file in their own repositories. That makes a C `webgpu.h`
client mostly mechanical and keeps the wgpu backend honest.

Opcodes are numbered explicitly in the data file, appended and never reused. There is no version
negotiation in `open`; `AGENTS.md` rules it out. Compatibility is the `waffleHostInterface`
integer ([compatibility](../docs/host-abi.md#compatibility)).

Not adopted: Dawn Wire's bytes (unversioned, generated enum positions, tied to one Dawn build),
wgpu-core-remote's bincode (Rust and serde specific), and `wasi:webgpu` as an ABI (needs the
Component Model). See [prior art](#prior-art).

### Identity

Handles are `(u32 id, u32 generation)` per object type. The guest reuses a released id with the
next generation and retires an id whose generation would overflow. The service rejects a handle
whose generation does not increase on creation, or that names a released object.

### Stream records

Header: `u16 opcode, u16 flags, u32 length`. Descriptors encode members in `webgpu.yml` order, with
a presence bitmask for optional members; strings and labels are length-prefixed UTF-8. A command
larger than the ring is sent as chunks (a flag bit) and reassembled by the service before decoding.

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
- **Lifetime:** `release(type, handle)`.

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
the process controller in [guest threads](wasi-threads.md). The WebGPU spec allows it
(`writeBuffer` and `writeTexture` take `AllowSharedBufferSource`). It still needs: each target
engine accepting such views in practice (G0 measures it),
the guest keeping the source range alive until the write's sequence number is reached, and the
process controller lending the memory to the service under the same revocation fences as
filesystem connections. Decide after measurement, not before.

## Browser support

The service needs `navigator.gpu` in a dedicated worker, a WebGPU context on an OffscreenCanvas,
and `Atomics.waitAsync`. As researched on 2026-10-31 (record exact versions again in G0):

- Safari 26, including iOS, has WebGPU in workers and on OffscreenCanvas
  ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/OffscreenCanvas.json)).
- Firefox ships WebGPU on Windows and, from 147, Apple Silicon; BCD lists its OffscreenCanvas
  WebGPU context as Windows only. Check macOS first.
- `Atomics.waitAsync`: Chrome 90, Firefox 145, Safari 16.4.
- Known gaps: WebGPU on Linux generally, and iOS memory limits per device.

CI today runs Playwright Chromium, Firefox and WebKit on Linux. Linux WebKit and Firefox likely
have no WebGPU there. G0 decides whether CI can run Chromium with a software adapter
(SwiftShader) and which engines are covered manually on the owner's Mac and iPhone through the
existing `tooling/workspace-safari-runner.ts` route.

## Delivery slices and effort

| Slice                  | Rough effort | Deliverable and exit gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0. Proof              | 5–8 days     | Hand-encoded stream from a single-threaded `wasm32-wasip1` C or Rust fixture draws a triangle into a granted canvas through a minimal service. Measure, in Chrome, Firefox, Safari on macOS and an iPhone: frame time of a light guest while another replays 20,000–50,000 draws, with and without per-task caps; replay cost per draw; the memory and startup of one extra worker with its own device; how many devices iOS allows; whether a canvas keeps its last frame after its worker ends; the `transferToImageBitmap` path at 1080p and 4K; `waitAsync` wake latency; `writeBuffer` from `SharedArrayBuffer` views. Record engine versions and whether CI can use a software adapter. |
| G1. Protocol and core  | 8–12 days    | The data file from `webgpu.yml`, its generator, handle tables, creation calls, recorded command buffers, queue writes, chunking, configure/acquire/present, frame slots. A fixture renders a textured, depth-tested scene with bind groups.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| G2. Async results      | 5–8 days     | Adapter and device negotiation, map reads with payloads, shadow writes, error scopes, compilation info, work done, uncaptured errors, device loss.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G3. Ownership and kill | 4–6 days     | Grants checked on configure, revocation at every process outcome, protocol-error isolation, fairness across connections, runtime disposal ordering, size budget. A kill during `append`, `completions` and mid-frame leaves the service usable.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| G4. Measurement        | 5–10 days    | Replay a captured Horizon-sized frame stream (thousands of draws, megabytes of uploads) and measure frame time, copy cost and ring sizing per engine. Decide on direct guest-memory reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| G5. Release            | 4–6 days     | Browser qualification, public host ABI and architecture docs, status page, troubleshooting entries for missing WebGPU.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

G0–G3 total **22–34 engineer-days**; through G5, **31–50**. G0–G3 need neither thread support nor
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
  slows others. Round-robin caps bound it. If G0 shows they are not enough, per-process workers
  can render offscreen and send frames by `transferToImageBitmap()` to page-owned canvases
  ([prior art](#prior-art)).
