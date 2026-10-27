# 004. Load the process service on first spawn

Status: accepted
Date: 2026-10-17

## Context

Many pages need only a filesystem. The process supervisor, executable registry and process table are most of the runtime's code, and `bun run size` enforces a gzip budget on the core bundle. A guest that blocks still needs a pid before the page has imported any of that code.

## Decision

The supervisor, registry and table are dynamically imported on the first spawn. Small leaves that a blocked guest needs earlier, the identity allocator, typed outcomes and signal state, load up front and must not import the service barrel. A first-spawn stub reserves the pid synchronously and shares one delayed activation promise. `AGENTS.md` makes the rule permanent: do not load the process implementation before the first spawn.

## Alternatives considered

- **Load everything with `createRuntime()`.** Every page pays for processes, including pages that never spawn. This is the simpler design and the one the size gates prevent.
- **Precreate workers before process use.** This would charge filesystem-only pages for process startup. After the first worker launch, the broker instead precreates at most two unused workers across all URLs. Workers are single-use; compiled modules retain the existing per-registration and bounded content caches. Paired Chromium command timings remain pending.

## Consequences

- `runtime.processes()` is asynchronous, and registering a program or adapter does not activate the service.
- Identity allocation lives in shared memory so a blocked guest can reserve a pid before activation.
- The core bundle is 8,779 bytes gzipped against a 9,782-byte budget, measured with `bun run size` on Bun 1.4.4. `fs` is 81,918 and `proc` is 57,438 bytes in the same run.
- Raising a budget needs the measured numbers in the same pull request.
