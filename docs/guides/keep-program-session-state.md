# Keep program loading bound to a session

Use one page-owned runtime for your terminal, agent and program panel. When the page
reopens a workspace, invalidate the previous session before awaiting its cleanup.
A late preparation result belongs to the session that started it.

The executable [program-session example](../../packages/waffle/examples/program-session.ts)
wraps Waffle's existing program collection. Copy it into your application and change
its import from `../index.js` to `waffle`. It is application code, not an additional
SDK entry point.

```ts
import { ProgramSession } from "./program-session";
import { ripgrep } from "waffle-ripgrep";

const session = new ProgramSession();
await session.open({
  filesystem: { mode: "fast", name: "workspace", whenBusy: "wait", workerURL: "/fs-worker.js" },
  programs: { onDemand: [ripgrep] },
});
await session.preload("rg");

// Read this again after terminal or agent changes and when the page becomes visible.
const snapshot = session.snapshot();
// Give the terminal and agent this runtime, rather than creating another one.
const runtime = session.runtime();
```

Handle rejections from `open`, `preload` and `close` in your application's error UI.
`preload` failures leave the runtime usable. Retry the same method to use Waffle's
existing preparation retry. The original startup promise keeps its original outcome.

## Read the collection instead of resolving programs again

An active snapshot's `catalog` is `unknown` during startup, `failed` after startup
rejects, or `known` after successful startup. Only a `known` catalog
with no entries means there are no registered programs. Never replace a rejected
probe with an empty array. A failed catalog includes the current collection handles
alongside its error. A successful retry updates those handles and `preparation`,
while preserving the original startup failure. An empty or unrelated preload cannot
erase that failure.

Each snapshot reads `runtime.programs.status()` again. Its handles expose Waffle's
existing `registered`, `preparing`, `loaded`, `error` and `removed` states. Terminal
and agent changes therefore appear in the panel without a separate GUI installer
or catalog. A failed optional tool stays registered with its error; it does not
close the filesystem or disable other commands.

## Reopen without accepting old results

Calling `open` again or calling `close` invalidates the current view immediately.
Old preparation success and failure return `superseded`; they cannot publish into
the replacement view. Startup and filesystem observers are bound to the same
generation. Waffle observers must remain small and must not reenter runtime control.

The example waits for the exact previous runtime's `dispose()` before creating the
next one. Pending source callbacks and package cleanup can keep that wait alive.
`closing` and `superseded` describe application state, not proof of physical stop.
A rejected disposal keeps the replacement blocked. It does not authorize a second
runtime. See [storage ownership](../storage.md) and
[program removal](configure-program-loading.md#inspect-and-remove-programs).

The preparation queue continues after a rejected operation. Queued requests capture
the current session when they begin. A request waiting behind old work can therefore
prepare the replacement workspace rather than retaining a stale runtime.

## Keep waiting and silence distinct

The snapshot exposes the existing typed filesystem state and latest startup stage.
It does not add a boot timeout, heartbeat counter, retry timer or visibility handler.
Keep the session object when the page is hidden. On resume, read its snapshot again.
Silence leaves pending work pending; it cannot turn an unknown catalog into an empty
one or prove that an operation stopped.

If your application already has startup budgets, retain its phase rules. Waiting for
the writer lock is ownership contention. Start or rearm the post-lock budget from
`filesystem-lock-acquired`, not from the beginning of the lock wait. Use actual
preparation progress for a program-loading budget. A reported deadline or no-progress
notice is separate from disposal completion and must not release ownership. See
[startup observations](../runtime-startup.md) for each stage's exact meaning.

The example's automated controls use real memory-backed runtimes and controlled
program loaders. They cover startup failure, retry, reopen during preparation,
late callbacks, current-session dequeue, collection refresh and pending cleanup.
They do not replace the existing actual-browser writer-lock tests.
