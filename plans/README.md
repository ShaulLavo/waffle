# Plans

Working plans for the agents and people who build Waffle. These files are not user documentation. `AGENTS.md` sends agent lanes here for the owning plan, so the folder keeps its path. The public docs and the README do not link to it.

Live plans: `001-vfs-family.md` (approved, in progress) and `browser-runtime.md` (boundaries overview plus two merged admission repairs). A finished plan becomes an ADR in `docs/adr/`, a public doc, or gets deleted.

Approved work: [Native guest threads](wasi-threads.md), with
[toolchain research and prior-art references](wasi-threads-references.md). This is an implementation
plan for execution; thread support is not yet delivered.

Proposed, not approved: [Guest graphics](guest-graphics.md), an overview of three plans that let a
WASI guest open a window and draw with WebGPU: [windows, input and a winit backend](guest-windows.md),
the [WebGPU bridge](gpu-bridge.md) and a [wgpu backend](wgpu-backend.md). It also proposes ADR 006
for Rust guest crates and records what Horizon, the first consumer, needs.
