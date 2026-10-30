# Evaluate a process-command plan

This package is not an installable command family yet. Its pure API is useful for fixture tests and for the pending Waffle host-command design.

```ts
import { planProcps, processRows } from "waffle-procps";

const service = await runtime.processes();
const supervisor = await service.ready();
const plan = planProcps({
  command: "ps",
  argv: ["-e", "-o", "pid,ppid,comm,args"],
  processes: processRows(supervisor.table.values()),
  selfPid: admittedPid,
});
```

The returned plan contains output, an unsupported result, or an inert signal request. Do not execute signal plans through raw supervisor methods or nominate a parent PID as authority. Waffle owns the missing capability described in [Missing Waffle contract](host-contract.md).

Run package checks from the workspace after dependencies are installed:

```sh
bun run --cwd packages/procps test
bun run --cwd packages/procps typecheck
```

[Bounded command behavior](compatibility.md) lists the supported grammar and exact native comparison boundary. [Process-command design](design.md) explains why the package exports no executable catalog.
