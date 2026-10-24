# 002. The page owns one runtime and guests borrow capabilities

Status: accepted
Date: 2026-10-17

## Context

A page can host a shell, a JavaScript engine and an editor at the same time. All of them need the filesystem, process ids and the network. Those are shared state: a tree, a pid counter and a port space. Guests also run in workers that may block, and a blocked guest cannot build channels or await a service.

## Decision

`createRuntime()` creates the one runtime a page may have, and a second call while one is alive throws. The runtime hands out capability objects that leave out disposal and owner internals. The page disposes the runtime. Guests only borrow its services.

## Alternatives considered

- **One runtime per guest or per shell.** Each gets simple ownership but its own tree, pid space and loopback network, so programs in different guests cannot share files, pipes or ports. This is the obvious option and the reason the borrowing rule exists.
- **Hand guests the owner object.** A guest could then dispose the runtime or reach private state. `runtime.ts` lists each public member in an explicit projection, so a new owner member needs a deliberate capability decision.

## Consequences

- Hot reload and tests must await `dispose()` before the next `createRuntime()`.
- `dispose()` runs in a fixed order: fence admitted filesystem work, stop consumers once quiet, close owned services, release the one-runtime guard.
- Adapters that start guests register a lease with `retainConsumer` and release it only after another owner has accepted the guest or its physical cleanup is done.
- A failed fence keeps the resources instead of claiming a clean stop.
