# Waffle contract and procps boundary

Status: Optional executable adapter on the merged Waffle host-command and delegated-signal APIs.

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

These original controls establish only the API distinction. The unchanged pure-size script retains its historical `runtimeAcceptance: "BLOCKED"` field, which is not an acceptance report for the optional catalog. `scripts/measure-commands.ts` measures the separate optional entry and lazy implementation.

## Optional adapter acceptance

`tests/runtime.test.ts` executes the catalog on the real memory-filesystem runtime and actual root controllers. It covers command output, self exclusion, controller grants, stale and revoked authority, bounded output, abort, missing descriptors, broken pipes, lazy identity, uninstall, and physical completion. Test-only scheduling hooks trigger stale and revoked cases between the real snapshot and send. They retain the original runtime grant and never install a caller-provided signal callback in production.

`scripts/check-packed.ts` extracts the source archive, binds its existing Waffle peer without another install, and runs ps, pgrep, and granted sibling pkill from that extracted entry. Its owned temporary directory is removed on completion. These checks do not launch Wasm or native commands.

No Waffle runtime files change. This contract is grounded in merged source `94aedc717551ef496d014ec2fed4f0770122553d`, including host-command commit `db1bcd95c06a8130fd85caa510754a7f14bf9b98`. It makes no claim that a published package or a consumer's current pin includes that source. No release or pin update is part of this feature.

Timestamp, resource, terminal, account, session, and Linux scheduling-state fields remain unsupported. Optional oldest/newest support needs a genuine immutable start-order or timestamp contract, not numeric PID order. Signal-zero emulation is not part of the bounded TERM, INT, KILL, and PIPE subset.
