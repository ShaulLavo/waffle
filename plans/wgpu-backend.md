# A wgpu backend for Waffle guests

Status: **Proposed plan. Nothing here is implemented.** The crate lives outside this repository
([where the code lives](guest-graphics.md#where-the-code-lives)).

Prepared: 2026-10-31. Inspected Waffle baseline
[`9b66e3aa2462771f65ca263745a23c80e2c8fea3`](https://github.com/ShaulLavo/waffle/commit/9b66e3aa2462771f65ca263745a23c80e2c8fea3),
wgpu and wgpu-types `30.0.1` from crates.io, and Horizon
[`4e833c2fe6cfec9698cff687ded95208e8871061`](https://github.com/horizon-rust/horizon/commit/4e833c2fe6cfec9698cff687ded95208e8871061)
as the first consumer. Estimates are engineering judgments; nothing has been measured.

Part of the [guest graphics](guest-graphics.md) family, alongside the
[WebGPU bridge](gpu-bridge.md) and [windows and input](guest-windows.md).

## Goal and supported boundary

A Rust crate, `waffle-wgpu`, that implements wgpu 30's `custom` backend on top of the
[`runtime_gpu` stream](gpu-bridge.md#guest-abi-runtime_gpu). An app built for `wasm32-wasip1` or
`wasm32-wasip1-threads` gets a working `wgpu::Instance` from one call and keeps the rest of its
wgpu code unchanged, including `pollster::block_on` around adapter and device requests and
`Device::poll(Wait)` around readbacks.

What it does not do: offer features WebGPU lacks (polygon modes, push constants, mappable primary
buffers, most native texture formats), run SPIR-V passthrough, expose `as_hal`, or report HDR
colour spaces.

## How an app uses it

```rust
#[cfg(target_os = "wasi")]
let instance = waffle_wgpu::instance();
#[cfg(not(target_os = "wasi"))]
let instance = wgpu::Instance::new(&descriptor);

let surface = instance.create_surface(window.clone())?; // winit window from the Waffle fork
```

`waffle_wgpu::instance()` returns `wgpu::Instance::from_custom(WaffleInstance::new())`
(`wgpu/src/api/instance.rs:432`). `create_surface` reads `RawWindowHandle::Web(WebWindowHandle {
id })`, which the [winit fork](guest-windows.md#the-winit-fork) supplies as the Waffle surface id.
Any other handle fails with a clear error.

## wgpu prerequisites

### The `custom` feature

On WASI, wgpu's `wgpu_core` and `webgpu` cfgs are both false, so with `custom` enabled only the
custom backend compiles (`wgpu/build.rs`, `cfg_aliases`). Native backend features an app already
enables (`vulkan`, `metal`, `gles`) evaluate to nothing on WASI and can stay in its manifest.

### `Send` and `Sync` on WASI with threads (blocking)

wgpu removes `Send` and `Sync` from every type on `wasm32` unless the target lacks atomics and
`fragile-send-sync-non-atomic-wasm` is on (`wgpu-types/src/send_sync.rs`, `wgpu/build.rs`
`send_sync` alias). On `wasm32-wasip1-threads` atomics are on, so `wgpu::Device`, `Queue`,
`Buffer` and `Surface` are `!Send`. Apps that share them across threads stop compiling; Horizon is
one (for example `spare_surface: Mutex<Option<Surface>>`, `horizon-client-render/src/gfx.rs:464`).

The restriction exists because web backend objects are JavaScript values bound to one thread. A
WASI build has no JavaScript objects: the custom backend's handles are integers and its state is
behind ordinary locks. Fix:

1. Change both `send_sync` definitions to also hold for `all(target_arch = "wasm32", target_os =
   "wasi")`. Custom backend implementations then must be `Send + Sync`, which `waffle-wgpu` is.
2. Propose it upstream to wgpu with that rationale.
3. Until it is released, consumers apply it with `[patch.crates-io]` entries for `wgpu` and
   `wgpu-types`. Horizon already patches `wgpu-hal` and `naga` this way (`Cargo.toml:60-61`).

Single-threaded `wasm32-wasip1` apps do not need the patch.

## Design

### Crate layout

- `waffle-gpu-sys`: raw `runtime_gpu` imports and the opcode and record constants generated from
  [Waffle's data table](gpu-bridge.md#wire-format).
- `waffle-wgpu`: the backend. It depends on `wgpu` with `custom`, on `naga` with `wgsl-out` for
  IR translation, and optionally on naga's `glsl-in` and `spv-in` behind features.

### Mirroring wgpu's `webgpu` backend

wgpu's own `backend/webgpu.rs` (4,489 lines) already maps every wgpu call to one WebGPU call.
`waffle-wgpu` keeps its structure: the trait impls (`:1595` Instance through `:4399` mapped
range) become encoders that write stream records instead of calling JavaScript, and the pure
`map_*` helpers (`:236-1001`: formats, blend, depth/stencil, vertex formats, feature and limit
mapping) become the encoders' value tables. Code adapted from it needs a classified row in
`docs/bun-patches.md` with path, revision and notices (wgpu is MIT or Apache-2.0).

About 150 trait methods across 17 traits (`wgpu/src/dispatch.rs`) need an implementation; eight
traits are empty markers.

### Identity and lifetime

Every object holds an `(id, generation)` handle from a per-type allocator and an `Arc` to its
connection, following [the bridge's identity rules](gpu-bridge.md#wire-format). `Drop` appends
`release`. wgpu wraps implementations in `Arc<dyn …Interface>` and drops them
when the last user does, so release order follows wgpu's own rules.

### Buffering and flushing

Appends go into a guest-side buffer under the connection lock and reach the ring in that order.
The buffer flushes on `submit`, `present`, any blocking wait, `Device::poll`, and above 1 MiB.

Command encoders, render passes, compute passes and render bundle encoders record into their own
buffer with no lock and are sent as one `command-buffer` record when the encoder finishes.
`multi_draw_indexed_indirect` stays one record; the service expands it.

### Answering synchronous queries

`features`, `limits`, `downlevel_capabilities`, `get_info`, `adapter_info`,
`get_texture_format_features`, `wgsl_language_features`, `is_surface_supported` and surface
`get_capabilities` return cached values from the `adapter` and `device` completions.
`get_info().backend` is `Backend::BrowserWebGpu`, so apps that gate native-only paths on the
backend (Horizon's occlusion culling, `cull.rs:190-199`) turn them off. Downlevel capabilities are
WebGPU's: fully compliant, as wgpu's webgpu backend reports (`:1827`).

### Futures, callbacks and `poll`

A single **pump** per connection owns `completions`. Whoever needs a result takes the pump lock,
drains records into a token table, and, if its token is still missing, blocks in `completions`.
Other threads wait on a guest condition variable that the pump signals after each drain.

- `request_adapter`, `request_device`, `pop_error_scope`, `get_compilation_info` return futures
  whose `poll` runs the pump with a blocking wait. They resolve in one `poll`, so
  `pollster::block_on` works and so does any executor that tolerates a blocking poll.
- `map_async`, `on_submitted_work_done`, the device-lost callback and the uncaptured-error handler
  are queued and run inside `Device::poll` and `Instance::poll_all`, matching wgpu-core:
  `PollType::Poll` drains without blocking; `PollType::Wait` blocks until the named submission's
  work and every pending map on that device complete, or the timeout passes.
- `push_error_scope` is local bookkeeping plus a stream record; `pop_error_scope` is one round trip.
- The default uncaptured-error behaviour matches wgpu-core's (panic with the message), so bugs are
  not silent. An app's handler replaces it.

### Buffer mapping

- **Read:** `map_async(Read)` sends `map`; the `mapped` completion's payload is copied into a
  guest shadow `Vec` before the callback runs. `get_mapped_range` returns slices of it.
- **Write**, including `mapped_at_creation`: no service round trip. The guest writes into a shadow
  `Vec`; `unmap` sends the written ranges. The service applies them with `queue.writeBuffer`, so the
  service-side buffer carries `COPY_DST` instead of `MAP_WRITE`. Re-mapping a `MAP_WRITE` buffer
  resolves at once. This keeps `wgpu::util::StagingBelt` and `create_buffer_init` cheap.

### Shaders

- `ShaderSource::Wgsl`: passed through unchanged.
- `ShaderSource::Naga`: validated, then written as WGSL with naga's WGSL backend in the guest, as
  `webgpu.rs:1981-2013` does. Horizon's GLSL shader packs arrive this way.
- `Glsl` and `SpirV`: through naga frontends behind features.
- `create_shader_module_passthrough`: WGSL only.

### Surfaces

- `get_capabilities`: formats from the adapter completion (the browser's preferred canvas format,
  plus `rgba8unorm` and `bgra8unorm` where allowed), present mode `Fifo` only, alpha modes `Opaque`
  and `PreMultiplied`, usages `RENDER_ATTACHMENT | COPY_SRC | TEXTURE_BINDING`, no HDR colour spaces.
  Apps asking for `Mailbox` must fall back, as Horizon does (`gfx.rs:1437`).
- `configure`: sends `configure` and records the size.
- `get_current_texture`: reserves a frame slot (blocking while both are in flight), allocates a
  texture id and sends `acquire`. If the surface's current size from
  [`surface_info`](guest-windows.md#guest-abi-runtime_window) differs from the configured size,
  it returns `SurfaceStatus::Outdated` so the app reconfigures.
- `present`: sends `present` and flushes. `texture_discard` sends `present` with a discard flag.

## Delivery slices and effort

| Slice                    | Rough effort | Deliverable and exit gate                                                                                                                                                                                     |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0. Skeleton             | 4–6 days     | Against bridge slice G1: instance, adapter, device, surface, clear and present. wgpu's `hello_triangle` example runs as a `wasm32-wasip1` guest in Chromium.                                                  |
| B1. Coverage             | 8–12 days    | Every trait method, mapping tables adapted from `webgpu.rs`, recorded passes and bundles, shader paths. wgpu examples `cube`, `shadow`, `mipmap`, `msaa_line`, `boids` (compute) and `texture_arrays` render. |
| B2. Async and mapping    | 5–8 days     | Pump, futures, `poll` semantics, read and write mapping, `StagingBelt`, error scopes, compilation info, device loss. A screenshot readback through `map_async` + `poll(Wait)` matches native output.          |
| B3. Threads              | 3–5 days     | With [guest threads](wasi-threads.md) S4: the `Send`/`Sync` patch, the pump under contention, encoders recorded on worker threads. Upstream PR opened.                                                        |
| B4. Conformance and size | 5–8 days     | A selected subset of wgpu's own tests ported as guest fixtures; code size of `waffle-wgpu` in a release guest recorded; public docs for app authors.                                                          |

B0–B4 total **25–39 engineer-days**. B0–B2 need only single-threaded `wasm32-wasip1` and bridge
slices G1–G2.

## Acceptance

- The listed wgpu examples render the same image as native, compared by readback within a
  per-example tolerance.
- `pollster::block_on` around adapter and device requests returns, and `poll(Wait)` returns
  mapped data, without busy-waiting.
- Dropping every wgpu object releases every service id; a test checks the service tables are empty.
- With the `Send`/`Sync` patch, Horizon's renderer crate compiles for `wasm32-wasip1-threads`.

## Risks

- **Upstream acceptance.** If wgpu declines the `send_sync` change, consumers carry a two-crate
  patch per wgpu release. It is a cfg change, so rebasing is cheap.
- **Blocking futures.** A future that blocks inside `poll` stalls a cooperative executor running
  other tasks on the same thread. Document it; apps on WASI already block.
- **Round trips.** Each `pop_error_scope` is one. Horizon pops one per section-buffer allocation
  (`arena.rs:342`) and per shader-pack pipeline build. Measure in G4 of the bridge; if costly,
  Horizon can pop them in batches.
- **Feature honesty.** Apps that assume native limits or formats fail validation in the browser.
  Report exactly what the adapter grants.
