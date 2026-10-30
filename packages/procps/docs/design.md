# Process-command design

Status: Approved, implementation is limited to pure command plans. Waffle supports host commands, but this package does not implement their adapter.

## Caller and domain

`planProcps({ command, argv, processes, selfPid })` reads an immutable snapshot and returns formatted output, an unsupported result, or a signal plan. It does not register an executable, own a runtime, inspect the host, or send signals. A signal plan is not proof of delivery and has no success status.

`processRows(records)` projects admitted Waffle records into PID, original PPID, executable basename, and argv text. It omits roots with no request, terminal outcomes, and exited records. A reserved or starting process remains visible because Waffle admitted its request. The snapshot copies only the displayed strings and numbers, never authority, descriptors, environment, or shared buffers.

Command names come from the executable basename, not argv[0]. Full command text joins request argv with spaces, without shell quoting. `pgrep` name matching uses the first 15 UTF-8 bytes of that basename. This is a compatibility convention, not a claim that Waffle has Linux's kernel `comm` field. PID sorting means numeric ordering only, never age.

## Existing runtime flow

`defineProgramPackage` retains definition identity across `pick`. `ProgramCollection` installs canonical marker paths and aliases without loading payloads. Since Waffle commit `db1bcd95c06a8130fd85caa510754a7f14bf9b98`, `ProgramDefinition` and `PackageProgram` also accept a `command` definition with a lazy loader. The registry resolves this as a command, not a compiled module. Waffle owns its process context, stdio, cancellation, and physical completion.

The pure package predates that runtime contract. It exports no `procps` catalog or host-command adapter and creates no stub Wasm or surrogate interpreter. Runtime support alone does not make these plans installable shell commands.

## Alternatives considered

1. A real Wasm procps front end would need a new guest-readable process-table ABI and authorized signaling ABI. The current ABI does not expose the table. This adds transport and snapshot complexity that these commands do not need.
2. A module-less trusted host command hides registration, lazy implementation loading, stdio, cancellation, and physical-stop accounting in Waffle. Waffle now supplies this contract. A procps adapter and package-level acceptance tests remain separate work.
3. A launch hook with empty Wasm would fit the type but misrepresent executable identity and admission. It is rejected, as is borrowing an unrelated interpreter.

The bounded implementation separates pure matching and output from runtime lifecycle integration. The public function hides option parsing and formatting. It deliberately leaves signal delivery to an authorized Waffle capability, rather than accepting a generic callback that could bypass control policy.

## Signals and authority

At the accepted source, `checkedSignal` accepts 1 through 64 except invalid 32 and 33, and unsupported stop signals 19 through 22. Signal zero is invalid. The older native fixture report predates this expansion. This package plans only 2, 9, 13, and 15.

`supervisor.canSignal` permits self and descendants only. A normally spawned `pkill` is a sibling of shell-owned targets. Neither passing its parent's PID as authority nor calling raw `supervisor.kill` is an acceptable workaround. Waffle now supplies `DelegatedSignals` only when a command requests delegation and its spawning controller grants the installed package identity. This package neither requests nor uses that capability.

## Verification boundary

Recorded native cases prove pure selection, formatting, and status behavior where fields exist. Pure plans do not prove registered execution, signal delivery, lazy admission, uninstall fences, or runtime disposal. The runtime controls reject incomplete Wasm definitions, accept an unloaded host-command registration, and retain ordinary sibling denial. They do not prove procps execution or delegated delivery. No native collector rerun is needed.
