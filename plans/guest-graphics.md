# Guest graphics: windows, WebGPU and wgpu

Status: **Proposed plan family. Nothing here is implemented or approved.**

Prepared: 2026-10-31. Inspected Waffle baseline
[`9b66e3aa2462771f65ca263745a23c80e2c8fea3`](https://github.com/ShaulLavo/waffle/commit/9b66e3aa2462771f65ca263745a23c80e2c8fea3)
and Horizon
[`4e833c2fe6cfec9698cff687ded95208e8871061`](https://github.com/horizon-rust/horizon/commit/4e833c2fe6cfec9698cff687ded95208e8871061).

Waffle runs WASI programs that read files, spawn processes and talk over loopback. This family
lets them open a window and draw with the GPU, so a desktop Rust app built on winit and wgpu can
run in a tab with its event loop and renderer unchanged.

| Plan                                  | Owns                                                                                                   | Language |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| [Windows and input](guest-windows.md) | `runtime.display()`, surface grants, the input ring, `runtime_window`, `waffle-window`, the winit fork | TS, Rust |
| [WebGPU bridge](gpu-bridge.md)        | The GPU service worker, `runtime_gpu`, the WebGPU command stream and completions                       | TS       |
| [wgpu backend](wgpu-backend.md)       | `waffle-wgpu`: wgpu's `custom` backend over the stream, and the wgpu `Send`/`Sync` patch               | Rust     |

The first consumer is [Horizon](#first-consumer-horizon), a Rust rewrite of a large voxel game.

## How the pieces fit

```mermaid
flowchart LR
  page["page: canvas element, DOM input"] -->|createSurface| display["display module (main thread)"]
  display -->|input records| ring["input ring"]
  display -->|OffscreenCanvas| gpu["GPU service worker: GPUDevice, canvas contexts"]
  ring -->|events_read| guest["guest worker(s): winit fork + waffle-wgpu"]
  guest -->|command stream| gpu
  gpu -->|completions| guest
```

The page owns the canvas, the display module and the GPU service. A guest process borrows a surface
grant. Its winit event loop blocks in `events_read`; its wgpu calls become stream records the GPU
service replays. Neither the canvas nor any WebGPU object enters guest JavaScript.

## ADR 006 (proposed): Rust guest crates

`AGENTS.md` allows Rust only for the network module ([ADR 005](../docs/adr/005-lazy-rust-wasm-network.md)).
These plans need Rust on the **guest** side: libraries that guest programs link, which never enter
a browser bundle. Proposal, to be recorded as ADR 006 when approved:

- A second Cargo workspace, `packages/waffle-guest/`, with `waffle-window`, `waffle-gpu-sys` and
  `waffle-wgpu` (and later `waffle-net`, see [networking](#networking)). Targets
  `wasm32-wasip1` and `wasm32-wasip1-threads` only.
- Consumers depend on it by exact Git revision, as they pin the runtime today. Not published to
  crates.io in the first release.
- `rust-version` stays at or below the oldest supported consumer toolchain (Horizon needs 1.95).
  CI builds with Waffle's pinned toolchain and with that minimum.
- The bridge's opcode table has one TypeScript source. A generator writes the Rust constants, the
  generated file is checked in, and CI fails when it is stale.
- Page-side code stays TypeScript. No Rust enters the display module or the GPU service.
- The winit fork lives in a separate repository unless the owner prefers vendoring
  ([options](guest-windows.md#where-the-fork-lives)).

## Order of work

Two lanes can start now, without [guest threads](wasi-threads.md):

1. **Windows:** W0 → W1 → W2 → W3 → W4 ([slices](guest-windows.md#delivery-slices-and-effort)).
2. **GPU:** G0 → G1 → G2 → G3 ([slices](gpu-bridge.md#delivery-slices-and-effort)), with B0 → B1
   → B2 of the [wgpu backend](wgpu-backend.md#delivery-slices-and-effort) starting after G1.

Everything single-threaded is testable with wgpu's own examples on `wasm32-wasip1`. Once threads
reach S4, W5 and B3 finish the threaded paths, and Horizon can boot.

| Lane              | Engineer-days | Depends on               |
| ----------------- | ------------- | ------------------------ |
| Windows W0–W4     | 16–25         | Nothing new              |
| GPU G0–G3         | 21–32         | Nothing new              |
| wgpu B0–B2        | 17–26         | G1, G2, W2 (surface ids) |
| Threaded W5, B3   | 6–10          | Threads S4               |
| Release G4–G5, B4 | 14–24         | All of the above         |

## First consumer: Horizon

Horizon is a Rust rewrite of a large voxel game: about 850,000 lines, wgpu 30, winit 0.30, many
threads (a server thread, chunk generation, meshing, lighting, LOD, networking). Single player
already runs its world on a server thread that the window joins through memory, not TCP.

### What builds today

Measured on 2026-10-31 with Rust 1.95, target `wasm32-wasip1-threads`, wasi-sdk's threads sysroot
as the C compiler, and `cargo build -p horizon-client --no-default-features --keep-going`:

- Build unchanged: `horizon-core`, `horizon-world` (world generation and block rules, about 174,000
  lines), `horizon-protocol`, `horizon-assets`, `horizon-command`, `horizon-items`,
  `horizon-client-core`, and the C and OS dependencies `ring`, `rustix`, `fs4`, `ureq`, `flate2`, `zip`.
- `horizon-threads` builds after swapping mimalloc for the system allocator on WASI (a few lines).
- Fail: `winit` (no platform), `horizon-hdr` (Vulkan internals), `arboard` (no clipboard
  platform), `socket2` and `if-addrs` (used by Horizon's direct-connect code).
- `wgpu` compiles but has no backend, so it would find no adapter.

### What Horizon would change

All behind `cfg(target_os = "wasi")`, kept small enough to upstream:

- `[patch.crates-io]`: the winit fork, and `wgpu` plus `wgpu-types` with the
  [`Send`/`Sync` patch](wgpu-backend.md#send-and-sync-on-wasi-with-threads-blocking).
- `horizon-client-render/src/gfx.rs:1185`: `waffle_wgpu::instance()` instead of `Instance::new`.
- `horizon-threads`: system allocator; `horizon-hdr`: excluded.
- `horizon-client-input/src/clipboard.rs`: `SystemClipboard` backed by `waffle-window`'s clipboard
  slot instead of arboard. The existing `Clipboard` trait already isolates it.
- Gamepads (`controllers` feature) and audio (`cpal`) off at first. Audio needs its own plan
  (an AudioWorklet fed from shared memory).
- Game files: `horizon-prepare` runs Java, so the player prepares files on a desktop and imports
  the prepared folder into the Waffle filesystem. No game assets are hosted.

### Measure before promising

- **Memory.** The threads plan keeps 32-bit memory, so every thread shares at most 4 GiB. Horizon
  will need a low default render distance in the browser. Measure peak memory natively first.
- **Thread count.** `std::thread::available_parallelism` on this target calls wasi-libc's
  `sysconf(_SC_NPROCESSORS_ONLN)`. The threads plan should make it report the runtime's
  parallelism, or Horizon sizes its pools for one core.
- **GPU stream volume.** Horizon issues thousands of draws per frame and blocks on an error scope
  per section-buffer allocation. Bridge slice G4 replays a captured Horizon frame.

## Networking

Sockets stay on. Waffle's relay (`packages/waffle-relay`, outbound HTTP today, with TCP and
WebTransport planned) gives guests a route out. Horizon on Waffle then needs:

- **A socket ABI for plain Preview 1 commands.** `std::net` on `wasm32-wasip1` cannot connect or
  listen, and Preview 1 `sock_*` calls return `ENOTSUP` in Waffle today; TCP reaches only adapters
  such as Bun's. A `runtime_net` namespace over the existing `NetHost` ring, plus a `waffle-net`
  crate with `TcpStream`/`TcpListener` shapes, would serve every Rust and C guest. This belongs to
  the network and relay lane; this family only depends on it.
- **Loopback inside the page.** Horizon's play-with-friends tunnel connects to local loopback
  ports. Waffle's virtual loopback already carries that between workers.
- **Outbound TCP through the relay** for joining servers and for Horizon's own `horizon-relay`
  fallback, which carries play-with-friends for both host and guest over outbound TCP. That makes
  hosting a world for friends possible from a tab.
- **What stays off in a tab:** LAN discovery (UDP multicast), STUN, and router port mapping
  (PCP, NAT-PMP, UPnP). They describe the real local network, which a tab cannot reach.
  Horizon's direct-connect path (`socket2`, `if-addrs`) is compiled out on WASI and the relay
  path is used instead. WebTransport datagrams could carry other UDP later.
- **DNS.** Horizon resolves server SRV records itself (`horizon-protocol/src/resolver/dns.rs`).
  In a tab, names resolve at the relay.

## Open questions for the owner

1. Approve ADR 006 as proposed, or keep guest Rust crates out of this repository?
2. Winit fork in a separate repository (recommended) or vendored?
3. One GPU service per runtime (recommended), or one per process for stronger isolation at the cost
   of one canvas per process?
4. Should the stream also target a C `webgpu.h` implementation later? It changes nothing now but
   argues for keeping opcodes WebGPU-shaped, which the bridge plan already does.
