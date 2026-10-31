# Install optional process commands

The page owns the runtime and filesystem. Install the optional catalog without creating another runtime:

```ts
import { procps } from "waffle-procps/programs";

await runtime.programs.onDemand(procps);
// Or install only one canonical definition and its aliases:
// await runtime.programs.onDemand(procps.pick("ps"));
```

Installation writes markers for `/usr/bin/ps`, `/usr/bin/pgrep`, and `/usr/bin/pkill`, with `/bin` aliases. It does not load the command implementation. The first execution or explicit preload loads that definition once across its aliases. Each invocation uses its admitted argv, descriptors, PID, root-local process snapshot, and abort signal.

Run commands through the caller's existing shell or process controller:

```sh
ps -e -o pid,ppid,comm,args
pgrep -fa worker
pkill -TERM -x worker
```

`pkill` requests delegated authority. The controller that adopts the runtime root must explicitly allow this catalog identity through `signalDelegation: { packages: [procps] }`. A `pick` retains that identity. Installing the package alone grants nothing. There is no package option for a raw signal callback or a nominated parent PID.

Commands ignore stdin. Bind stdout for output and stderr for diagnostics. Writes are awaited and use Waffle's bounded-pipe backpressure. Broken pipes, missing descriptors, and cancellation remain runtime failures, not successful output.

Remove an installed command with `await runtime.programs.get("ps")!.remove()`. Waffle closes new admission immediately and waits for its loader, callback, and outstanding I/O. Removal does not stop an already running command. The page still owns runtime disposal.

## Use the pure planner

The original `waffle-procps` entry remains pure. `planProcps({ command, argv, processes, selfPid })` returns output or an inert signal plan. It never signals a process. `processRows` remains available for callers that already have admitted Waffle records. Only the host adapter executes plans, through its genuine runtime grant.

## Run checks

After exact-input network verification, dependency installation, and Waffle package preparation:

```sh
bun run programs:procps
```

This runs the unchanged pure comparisons, type checking, real command acceptance, extracted-package execution, and sizes. `programs:procps:pure` runs only the pure comparisons, original runtime boundary controls, type checking, and original pure-entry measurement. Neither command rebuilds a native oracle or a guest.

[Bounded command behavior](compatibility.md) lists the supported options. [Waffle contract and procps boundary](host-contract.md) describes authority and lifecycle ownership.
