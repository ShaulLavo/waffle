# Process-command design

Status: Approved and implemented as a pure entry plus an optional host-command catalog.

## Caller and domain

`planProcps({ command, argv, processes, selfPid })` reads an immutable snapshot and returns formatted output, an unsupported result, or a signal plan. It does not register an executable, own a runtime, inspect the host, or send signals. A signal plan is not proof of delivery and has no success status.

`processRows(records)` projects admitted Waffle records into PID, original PPID, executable basename, and argv text. It omits roots with no request, terminal outcomes, and exited records. A reserved or starting process remains visible because Waffle admitted its request. The snapshot copies only the displayed strings and numbers, never authority, descriptors, environment, or shared buffers.

Command names come from the executable basename, not argv[0]. Full command text joins request argv with spaces, without shell quoting. `pgrep` name matching uses the first 15 UTF-8 bytes of that basename. This is a compatibility convention, not a claim that Waffle has Linux's kernel `comm` field. PID sorting means numeric ordering only, never age.

## Existing runtime flow

`defineProgramPackage` retains definition identity across `pick`. `ProgramCollection` installs canonical marker paths and aliases without loading payloads. Since Waffle commit `db1bcd95c06a8130fd85caa510754a7f14bf9b98`, `ProgramDefinition` and `PackageProgram` also accept a `command` definition with a lazy loader. The registry resolves this as a command, not a compiled module. Waffle owns its process context, stdio, cancellation, and physical completion.

The optional `waffle-procps/programs` entry exports `procps` and `procpsPrograms`. Each canonical definition carries a stable loader and `/bin` alias. The loader imports `command.ts`, which calls the unchanged pure planner. The default pure entry does not import the catalog. There is no Wasm, surrogate interpreter, separate runtime, or filesystem owner.

## Alternatives considered

1. A real Wasm procps front end would need a new guest-readable process-table ABI and authorized signaling ABI. The current ABI does not expose the table. This adds transport and snapshot complexity that these commands do not need.
2. A module-less trusted host command hides registration, lazy implementation loading, stdio, cancellation, and physical-stop accounting in Waffle. Waffle supplies this contract. The optional adapter uses it directly.
3. A launch hook with empty Wasm would fit the type but misrepresent executable identity and admission. It is rejected, as is borrowing an unrelated interpreter.

The bounded implementation separates pure matching and output from runtime lifecycle integration. The public function hides option parsing and formatting. It deliberately leaves signal delivery to an authorized Waffle capability, rather than accepting a generic callback that could bypass control policy.

## Signals and authority

At the accepted source, `checkedSignal` accepts 1 through 64 except invalid 32 and 33, and unsupported stop signals 19 through 22. Signal zero is invalid. The older native fixture report predates this expansion. This package plans only 2, 9, 13, and 15.

`supervisor.canSignal` permits self and descendants only. A normally spawned `pkill` is a sibling of shell-owned targets. Neither passing its parent's PID as authority nor calling raw `supervisor.kill` is an acceptable workaround. Waffle now supplies `DelegatedSignals` only when a command requests delegation and its spawning controller grants the installed package identity. Only the `pkill` definition requests that capability. Its adapter uses only the capability supplied to its admitted context. A missing grant produces an explicit diagnostic and no send.

## Verification boundary

Recorded native cases prove pure selection, formatting, and status behavior where fields exist. Pure plans do not prove registered execution, signal delivery, lazy admission, uninstall fences, or runtime disposal. The original runtime controls still reject incomplete Wasm definitions, accept an unloaded host-command registration, and retain ordinary sibling denial. New tests execute actual procps commands on owned runtime fixtures and exercise the extracted package. No native collector rerun is needed.

## Adapter execution

The adapter snapshots `context.processes` once, then derives only basename, argv text, PID, and original PPID. It removes argv[0] before parsing options and uses the admitted PID for self exclusion. It does not read host metadata or synthesize unavailable fields.

Output writes are awaited in 4096-byte chunks. The adapter checks cancellation before snapshotting, each write and each signal send, and before returning success. It neither drains stdin nor catches I/O failures. Waffle owns broken-pipe and revoked-descriptor outcomes.

Signal plans remain inert in the pure API. The adapter counts actual `sent` outcomes and reports distinct `missing`, `denied`, and `revoked` outcomes. It does not retry a stale plan or broaden scope. A controller grant cannot cross runtime roots or signal the root itself. Honest root-local snapshots normally prevent selecting such denied targets in the first place.
