# Host case queries and body timeouts

The public `waffle/testing/page-runner` entry exports `SuiteCase` and `HostCase`.
These options use the existing owned document, command queue, and page task receiver.

## Initial case query

`SuiteCase.query(run)` optionally returns a readonly string record. The host calls it
once for each selected case, before document binding, configuration, and navigation.
List, finish, and peer documents do not call it. Without a callback, URLs contain only
the host token, as before.

The host copies own enumerable entries into `URLSearchParams`. Keys start with an
ASCII letter and contain only letters, digits, underscores, or hyphens. Values are
strings, including empty strings. The record must have the ordinary object prototype
or a null prototype. Enumerable symbol keys, non-string values, and reserved keys fail
before the case document is bound. Reserved keys are case-insensitive: `token`, `url`,
`path`, `href`, `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`,
`hash`, `username`, and `password`.

The host appends its token and retains the resulting exact URL in the collector and
command guard. Later mutation of the returned record cannot change that binding.
Changing the page URL after admission still fails the guard. Declared service-worker
clients retain the same complete URL in their client binding.

```ts
const item: SuiteCase<null> = {
  id: "startup",
  label: "startup",
  request: () => null,
  query: (run) => ({
    test: "1",
    renderer: "canvas",
    workspace: `startup-${run}`,
  }),
  drive: async (host) => {
    const name = await host.allocateDatabase("startup");
    if ((await host.script("return new URL(location.href).searchParams.get('workspace')")) !== name)
      throw new Error("Workspace acknowledgement differs from the initial query");
    return true;
  },
};
```

A query is not storage authority. Query construction does not allocate or open a
database. A consumer that starts a demo must first await `allocateDatabase`, compare
its returned name with the prebound workspace, and only then evaluate the demo.
Different cases use different owned prefixes. Allocation policy and exact-ledger cleanup
remain the caller's existing contracts.

## Original-body-relative timeout

`host.setTimeout(timeoutMs): void` changes the private absolute body deadline to the
original body start plus `timeoutMs`, capped by the absolute run and document limits.
It accepts finite positive numbers. It never starts a fresh timeout at the setter call.

Both extensions and decreases apply to body checks, the monitor, `remainingMs`, sleeps,
and tasks or commands already in flight. A decrease below elapsed body time throws
synchronously and aborts the body. An expired or revoked body cannot be revived.
An explicit `Budgets.operation` still caps each operation independently, even after an
extension. Without that explicit cap, active operations follow the live body deadline.

The setter does not change shared budgets, hello, heartbeat, run, document, reporting,
or teardown clocks. Consumers retain their own timeout policy and current effective
timeout. A pending page task retains its actual promise and collector registration;
changing a timeout never reports a fabricated task completion or detaches cleanup debt.

## Hold an ordinary asset

Call `host.holdAsset(path, callback)` synchronously before a guarded task starts the
producer. The path must name an existing canonical ordinary asset. Each real GET
invokes its callback with only `request.continue(): Promise<void>`. Continue selects
that request's original response once, without replacing its bytes, status or headers.
It completes at server handoff, independently of callback completion.

Hold documents require exactly one executable HTML delivery and an exact full
same-origin referrer from the acknowledged case document. Missing or stale context
never selects the current case. A repeated protected document delivery is rejected.
Unheld cases and ordinary asset HEAD requests retain normal behavior. This is a
controlled top-level document contract, not arbitrary worker or referrer-free support.

The body owns its release promise and finally block. Revocation closes new admissions
but permits already admitted continuation. Body, callback and response work remain
owned until actual settlement. Verdict delivery, diagnostics, disposal and joins share
one teardown deadline from body revocation. Unsettled work forbids the next document
and leaves containment unconfirmed. Holds do not change any original case clock.
