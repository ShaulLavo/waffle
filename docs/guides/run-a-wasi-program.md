# Run a WASI program

Register a compiled WASI command with a runtime, spawn it from the page, read its output, and wait for its exit status. This guide assumes you finished [Getting started](../getting-started.md) and have the `fs-worker.ts` entry, the build command and the isolation-header server.

The pieces below are low-level. Bash Web and the Bun build use the same calls through their own adapters. Waffle makes no compatibility promise between revisions, so pin a commit.

## Compile a guest

Any WASI Preview 1 command that exports `_start` and a memory works. This one writes a line to stdout and exits with code 7. Save it as `hello.wat` and compile it with [WABT](https://github.com/WebAssembly/wabt):

```wat
(module
	(import "wasi_snapshot_preview1" "fd_write"
		(func $fd_write (param i32 i32 i32 i32) (result i32)))
	(import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
	(memory (export "memory") 1)
	(data (i32.const 8) "hello from a guest\n")
	(func (export "_start")
		;; iovec at address 0: pointer 8, length 19
		(i32.store (i32.const 0) (i32.const 8))
		(i32.store (i32.const 4) (i32.const 19))
		(drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 24)))
		(call $exit (i32.const 7))))
```

```sh
wat2wasm hello.wat -o public/hello.wasm
```

## Add the worker entry

A process runs in its own worker. Waffle ships a generic WASI worker. Create `preview1-worker.ts` so your build includes it:

```ts
import "waffle/browser/preview1-worker";
```

## Spawn the program

Create `run.ts`. It registers an adapter that starts the generic worker, registers the program at an absolute path, and spawns it from a root process that stands in for the page:

```ts
import { createRuntime } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";

const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
});
const descriptors = new DescriptorTable();
try {
  const module = await WebAssembly.compileStreaming(fetch("/hello.wasm"));

  // The adapter decides how a program runs. This one starts the generic WASI worker.
  runtime.registerAdapter("preview1", (context, service) =>
    service.launchWorker(context, {
      workerUrl: "/preview1-worker.js",
      request: { module: context.module, args: context.request.argv, env: context.request.env },
    }),
  );
  await runtime.filesystem.writeFile("/bin/hello", "registered executable\n");
  runtime.registerProgram("/bin/hello", { adapter: "preview1", module, cooperative: true });

  const service = await runtime.processes();
  const supervisor = await service.ready();

  // The page needs a root process to own the spawn and the wait.
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: 2,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const unused = (): never => {
    throw new Error("this example transfers no descriptors");
  };
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  const stdout: string[] = [];
  await service.adoptRuntimeRoot(root, {
    output: (fd, bytes) => {
      if (fd === 1) stdout.push(new TextDecoder().decode(bytes));
    },
  });

  const pid = client.spawn(root.pid, {
    executable: "/bin/hello",
    argv: ["hello"],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  await supervisor.start(pid);
  const exit = await supervisor.waitForExit(root.pid, pid);
  console.log(stdout.join("").trimEnd());
  console.log(JSON.stringify(exit));
} finally {
  descriptors.dispose();
  await runtime.dispose();
}
```

Point `public/index.html` at `/run.js`, then bundle all three entries:

```sh
bun build ./run.ts ./fs-worker.ts ./preview1-worker.ts --outdir ./public --target browser --splitting
```

Serve the page and open the console. You should see:

```text
hello from a guest
{"kind":"exited","code":7,"status":7}
```

## What each part does

- **Program path.** `registerProgram` takes an absolute canonical path such as `/bin/hello`. You create the file at that path yourself with `writeFile`. Its contents do not matter. The registered module is what runs.
- **`cooperative: true`.** You pass a compiled `WebAssembly.Module`, so Waffle cannot insert interruption checkpoints. The flag says the guest cooperates. To have Waffle instrument the code, pass `source` bytes instead. See [Host ABI](../host-abi.md) for the interruption contract.
- **Root process.** A spawn needs a parent with a worker transport. A root from `supervisor.createRoot()` has none. `launchWorker` then throws `process has no admitted worker transport` and the spawn ends as `start-failed` with `EIO`.
- **Output.** `adoptRuntimeRoot` takes an `output(fd, bytes)` callback. It receives the stdout and stderr of every descendant of the root. A destination with limited room, such as a terminal ring, passes `tryOutput` instead. See [Host terminal output](../architecture.md#host-terminal-output).
- **Result.** `waitForExit` resolves to `{ kind: "exited" | "signaled", code, status }` or `{ kind: "start-failed", code, error, status: null }`. Spawning `/bin/missing` gives `start-failed` with `ENOENT`.

For adapters with their own startup hooks, see [Guest executor extensions](../architecture.md#guest-executor-extensions). For every guest import and result shape, see [Host ABI](../host-abi.md).

## Bind a socket before launch

A Preview 1 guest cannot call `connect`. Bind a socket at launch and give its fd to a program
that uses `send`, `recv` and `shutdown`, or the equivalent WASI `sock_*` imports. This example
binds fd 3. The root directory preopen moves to fd 4.

```ts
import { createPreview1Network } from "waffle/browser/preview1-network";
import type { NetConnect } from "waffle/browser/net/outbound";

// Supply the application's trusted connector on the page, never in guest env or worker data.
const connect: NetConnect = appConnect;
runtime.registerAdapter("preview1", async (context, service) => {
  const network = await createPreview1Network(runtime, {
    connect,
    sockets: [{ fd: 3, socket: { connect: { host: "echo.example", port: 4321 } } }],
  });
  return service.launchWorker(context, {
    workerUrl: "/preview1-worker.js",
    network,
    request: { module: context.module, args: context.request.argv, env: context.request.env },
  });
});
```

The helper runs on the page, so the guest worker can block without preventing the connector
from making progress. `launchWorker` owns cleanup after the handoff, including failed setup,
revocation and normal exit. Empty `sockets` creates no helper. Without `connect`, virtual
loopback still works and a non-loopback socket reports `ENOTSUP` when the guest uses it.

Use `FDFLAG_NONBLOCK` for immediate I/O and `poll_oneoff` for readiness. `RECV_WAITALL` waits for
the requested bytes unless EOF or an error occurs. `SHUT_WR` allows replies after local FIN;
`SHUT_RD` discards local input without sending FIN. Listener bindings and `sock_accept` are not
implemented. This does not let arbitrary unmodified programs connect to destinations they
choose at runtime.

The runnable fixtures are `packages/waffle/tests/fixtures/preview1-socket.wat` and
`preview1-socket.c`. The C fixture takes the socket fd in argv and uses the published patched
wasi-libc build route to discover the moved preopen. `bun run test:libc` builds and discovers its
blocking and nonblocking tests. The regular test suite discovers the WAT matrix without a native
guest compiler. The SSLRequest case is transport coverage, not a database query.

For a custom launcher such as bun-wasm's `preview1Launcher`, pass only `network.connection` to
`bootstrap` as `request.network`, transfer its `port`, and keep `network.dispose()` on the page.
The [Host ABI](../host-abi.md#preview-1-launch-sockets) lists the exact cloneable payload and
socket results. Do not clone `NetConnect`, credentials, streams or the helper into the guest.
