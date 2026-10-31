# Shared-memory reservations

Waffle can measure the browser's shared-memory reservation pool with
`measureSharedMemory()` and pass that result to `createRuntime({ sharedMemory })`.
The result is a feature test, not a user-agent guess. A platform that reaches the
16 GiB probe ceiling keeps desktop sizing; a bounded result carries its measured
budget and the reservation kinds that counted against it.

Generic browser workers must declare a `reservation` on `WorkerLaunchOptions` before
Waffle constructs their filesystem connection or `Worker`. The current extracted
worker path supports `reservation: { memory: "none" }`; non-`none` guest reservations
are rejected before launch because this source tree has no safe module-memory handoff.
A refusal is a `SharedMemoryAdmissionError` with `errno === 48` and
`code === "ENOMEM"`; its `refusal` contains the requested, available, budget and
awaiting-release bytes.

Runtime-held reservations created through the ledger remain charged until collection.
Worker memory is credited only after successful worker stop. Ledger request arenas are
pooled and reused. Bounded policy uses 64 MiB arena slots and fixed 16,384-page group
memory; desktop keeps the 2,147,479,552-byte arena policy and growable group policy.

The public `Runtime.sharedMemory.snapshot()` is a policy-ledger snapshot, not a
complete page allocation census in this extracted package. Current filesystem root and
segment buffers, pipe transport buffers, and other direct SAB construction sites are
not ledger-owned and are intentionally not claimed by the snapshot.

The current extracted Waffle package also does not contain the historical memory-group
implementation from design source commit `5ffb379b14e129e6505b499d91aa743cd80b3d38`.
The ledger models group policy and safe shape-keyed recycling, but this package's broker
has no memory-group construction site to route through it. Those integrations remain a
follow-up for the coordinator rather than a compatibility shim in this PR.
