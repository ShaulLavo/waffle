# Missing Waffle contract

Status: Blocked on Waffle-owned API work at accepted commit `620da8002cf2dab88862a0a503e228413b52603a`.

## Minimal registration control

`tests/runtime-gap.test.ts` creates the real runtime and filesystem worker, then attempts module-less registration with a real marker. Waffle rejects it before launch. With neither `source`, `module`, nor `script`, `registerProgram` throws `Compiled modules require cooperative: true`. Adding cooperative trust without a module throws `Program module must provide a compiled WebAssembly.Module`. The subsequent real supervisor start fails `ENOEXEC`. No empty Wasm or interpreter is registered.

This test passing means the blocker still exists. It does not qualify `ps`, `pgrep`, or `pkill` for shell execution.

## Smallest registration and lifecycle need

Waffle needs a module-less variant in both `ProgramDefinition` and `PackageProgram`. Exact naming belongs to Waffle. Its contract must support:

- A stable, canonical host-command definition and lazy source loader, shared by all aliases and `pick` selections. Installing or checking access writes and admits markers only. Preload explicitly loads that same definition. No WebAssembly compilation occurs for this variant.
- A host command context with the real PID, original request, borrowed process-query capability, admitted stdio streams, and a revocation signal. It must not claim to contain a WebAssembly module. The source receives no runtime owner or disposal method.
- Ordinary process startup and exit reporting, including descriptor errors and nonzero statuses. The existing registry filesystem walk still decides executable admission.
- Cancellation before and after load. Uninstall must reject new entry immediately, wait for admitted loaders and physically stopped commands, then release definition paths and package resources. A late async loader must not enter after revocation or runtime disposal.
- One physical-stop handle or equivalent task completion per command. Runtime disposal must quiesce admitted filesystem work before stopping consumers, then release the one-runtime guard.

A callable host variant must be a real executable kind through the registry and supervisor, not an optional missing module on a context that promises `module: WebAssembly.Module`.

## Smallest control need

The query side already exists through `Runtime.processes()` and `service.ready().table`. The snapshot must stay host-side and copy only public process fields into command data.

Signaling needs an explicitly authorized trusted-command operation. `supervisor.canSignal(commandPid, targetPid)` rejects a command's sibling, even when that sibling was created by the same shell. `supervisor.kill` alone performs no caller check. Replacing the caller PID with the parent's PID would silently create authority, so this package does neither.

Waffle must define whether trusted process commands receive a delegated scope from the spawning controller. An operation such as `signal(targetPid, signal)` must enforce that scope, target identity, liveness, and command revocation at delivery. A stale pure plan grants no permission. Per-target errors must distinguish missing and unauthorized targets so the package can count actual successful deliveries. No signal-zero emulation is needed for the useful TERM, INT, KILL, and PIPE subset.

Timestamp, resource, terminal, account, session, and Linux scheduling-state fields remain unsupported. They are not prerequisites for the bounded `-o` and matching subset. Optional oldest/newest support needs a genuine immutable start-order or timestamp contract, not numeric PID order.

## Parent integration

No shared runtime changes are included in this package branch. The parent owns the Waffle prerequisite and final integration. After it is published, replace these blocker controls with positive registration, lazy loading, alias identity, own-child delivery, removal, revocation, and physical-stop acceptance controls. Keep the pure fixture comparisons.
