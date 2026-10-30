# Process-command design

Status: Approved, implementation is limited to pure command plans until Waffle supports host commands.

## Caller and domain

`planProcps({ command, argv, processes, selfPid })` reads an immutable snapshot and returns formatted output, an unsupported result, or a signal plan. It does not register an executable, own a runtime, inspect the host, or send signals. A signal plan is not proof of delivery and has no success status.

`processRows(records)` projects admitted Waffle records into PID, original PPID, executable basename, and argv text. It omits roots with no request, terminal outcomes, and exited records. A reserved or starting process remains visible because Waffle admitted its request. The snapshot copies only the displayed strings and numbers, never authority, descriptors, environment, or shared buffers.

Command names come from the executable basename, not argv[0]. Full command text joins request argv with spaces, without shell quoting. `pgrep` name matching uses the first 15 UTF-8 bytes of that basename. This is a compatibility convention, not a claim that Waffle has Linux's kernel `comm` field. PID sorting means numeric ordering only, never age.

## Existing runtime flow

`defineProgramPackage` retains definition identity across `pick`. `ProgramCollection` installs canonical marker paths and aliases without loading payloads. `installPrograms` requires Wasm bytes, a Wasm URL, or a script with a real interpreter. Its launch hook runs only after `ExecutableRegistry.resolve` supplies a compiled module. The supervisor then gives the launcher a process context. Package activity ends only when the returned handle physically terminates.

This design cannot honestly supply that module. It exports no `procps` catalog and creates no stub Wasm or surrogate interpreter. The package has no installable shell commands yet.

## Alternatives considered

1. A real Wasm procps front end would need a new guest-readable process-table ABI and authorized signaling ABI. The current ABI does not expose the table. This adds transport and snapshot complexity that these commands do not need.
2. A module-less trusted host command hides registration, lazy implementation loading, stdio, cancellation, and physical-stop accounting in Waffle. This is the preferred eventual integration, but accepted main has no such contract.
3. A launch hook with empty Wasm would fit the type but misrepresent executable identity and admission. It is rejected, as is borrowing an unrelated interpreter.

The bounded implementation separates pure matching and output from the missing lifecycle contract. The public function hides option parsing and formatting. It deliberately leaves signal delivery to an authorized Waffle capability, rather than accepting a generic callback that could bypass control policy.

## Signals and authority

At the accepted source, `checkedSignal` accepts 1 through 64 except invalid 32 and 33, and unsupported stop signals 19 through 22. Signal zero is invalid. The older native fixture report predates this expansion. This package plans only 2, 9, 13, and 15.

`supervisor.canSignal` permits self and descendants only. A normally spawned `pkill` is a sibling of shell-owned targets. Neither passing its parent's PID as authority nor calling raw `supervisor.kill` is an acceptable workaround. Waffle must define an explicit, bounded delegated control capability for this workflow.

## Verification boundary

Recorded native cases prove pure selection, formatting, and status behavior where fields exist. Pure plans do not prove registered execution, signal delivery, lazy admission, uninstall fences, or runtime disposal. Tests of rejected registration are blocker controls, not runtime acceptance. No native collector rerun is needed.
