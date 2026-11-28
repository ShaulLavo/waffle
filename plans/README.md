# Plans

Working plans for the agents and people who build Waffle. These files are not user documentation. `AGENTS.md` sends agent lanes here for the owning plan, so the folder keeps its path. The public docs and the README do not link to it.

Live plans: `001-vfs-family.md` (approved, in progress) and `browser-runtime.md` (boundaries overview plus two merged admission repairs). A finished plan becomes an ADR in `docs/adr/`, a public doc, or gets deleted.

Shipped milestone: [Native guest threads](wasi-threads.md) M1 delivered the experimental
source-admitted Runtime thread path and browser CI coverage, documented in
[Run the Runtime thread fixture](../docs/threads-runtime-runner.md).
[Toolchain research and prior-art references](wasi-threads-references.md) keeps the background
notes. General launch, broader import support, and physical iPhone qualification remain follow-up work.

Approved (owner, 2026-11-02): [Guest graphics](guest-graphics.md), an overview of three plans that
let a WASI guest open a window and draw with WebGPU: [windows, input and a winit backend](guest-windows.md),
the [WebGPU bridge](gpu-bridge.md) and a [wgpu backend](wgpu-backend.md). It also records where
the guest Rust crates live (outside this repository) and what Horizon, the first consumer, needs.
The WebGPU bridge is active since 2026-11-06; its [implementation design](gpu-bridge-implementation.md)
holds the slices. Windows and the wgpu backend stay scheduled later.

Approved, preserved for later (owner, 2026-11-04): [Vite 8 in the playground](vite8-playground.md).

Approved, scheduled later (owner, 2026-11-16): [A live shell on the landing page](site-live-shell.md).
