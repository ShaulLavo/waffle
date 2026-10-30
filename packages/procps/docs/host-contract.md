# Waffle contract and procps boundary

Status: Pure package only. Waffle supplies host-command and delegated-signal APIs, but procps does not implement an executable adapter.

## Historical blocker

At accepted commit `620da8002cf2dab88862a0a503e228413b52603a`, Waffle had no module-less executable variant. An adapter without `source`, `module`, or `script` failed with `Compiled modules require cooperative: true`. Adding cooperative trust without a module failed with `Program module must provide a compiled WebAssembly.Module`.

Waffle commit `db1bcd95c06a8130fd85caa510754a7f14bf9b98` added a separate `command` variant to `ProgramDefinition` and `PackageProgram`. Those incomplete Wasm definitions still fail. Their rejection no longer means that Waffle cannot register host commands.

## Current runtime contract

The command variant supplies the runtime-owned behavior that was missing:

- A canonical definition with a lazy `command.load` loader, shared by aliases and `pick` selections. Install and access checks do not load its implementation or compile WebAssembly.
- A `HostCommandContext` with the real PID, original request, root-local process snapshots, stdio streams, an abort signal, and optional delegated signals. It exposes no module, runtime owner, or raw supervisor.
- Registry marker admission, ordinary startup and exit reporting, cancellation, removal, and physical completion accounting.
- Explicit signal delegation. The definition requests `signals: "delegated"`, and the spawning controller grants installed package identities through `signalDelegation.packages`. `DelegatedSignals.send` reports `sent`, `missing`, `denied`, or `revoked` and checks current authority and liveness.

Ordinary `supervisor.canSignal(commandPid, targetPid)` still rejects siblings. That restriction does not describe the separate delegated capability. Passing the parent's PID or calling raw `supervisor.kill` is not a substitute for a grant. A stale pure plan grants no permission.

## Bounded package controls

`tests/runtime-gap.test.ts` creates the real runtime and filesystem worker. It preserves the incomplete Wasm-definition rejection assertions and proves that their unregistered marker fails startup with `ENOEXEC`. It also registers and releases a valid host-command definition without loading or executing it. No empty Wasm or interpreter is registered.

A separate real-supervisor control projects admitted reservations into pure rows and checks ordinary sibling denial without sending a signal. The signal-number control retains Waffle's rejection of signal zero and unsupported stop signals.

These controls establish the current API distinction. They do not qualify `ps`, `pgrep`, or `pkill` for shell execution. The size report's `runtimeAcceptance: "BLOCKED"` refers to that unimplemented procps integration, not an absent Waffle API.

## Remaining procps integration

No shared runtime changes or executable catalog are included in this package. A future procps adapter needs package-level controls for registration, lazy loading, alias identity, stdio, delegated delivery, removal, revocation, and physical completion. Pure fixture comparisons remain required and do not prove those behaviors.

Timestamp, resource, terminal, account, session, and Linux scheduling-state fields remain unsupported. Optional oldest/newest support needs a genuine immutable start-order or timestamp contract, not numeric PID order. Signal-zero emulation is not part of the bounded TERM, INT, KILL, and PIPE subset.
