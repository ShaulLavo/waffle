# Run an installed Wasm command

Use `startCommand` to run a program in the page's existing Waffle runtime. It returns a handle
for sending signals and a promise for the outcome and captured output.

The example uses the packaged `cat` from `@waffle-os/coreutils`. Build
`@waffle-os/runtime/browser/fs-worker` and `@waffle-os/runtime/browser/preview1-worker` as
`/fs-worker.js` and `/preview1-worker.js`. Serve the page with the isolation headers in
[Getting started](../getting-started.md).

```ts
import { createRuntime, type Runtime } from "@waffle-os/runtime";
import { startCommand } from "@waffle-os/runtime/command";
import { coreutils } from "@waffle-os/coreutils";

const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
  programs: {
    launcher: (context, service) =>
      service.launchWorker(context, {
        workerUrl: "/preview1-worker.js",
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      }),
  },
});

async function copyLine(runtime: Runtime): Promise<string> {
  await runtime.programs.onDemand(coreutils.pick("cat"));
  const command = startCommand(runtime, "/usr/bin/cat", {
    filesystem: "runtime-root",
    stdin: new TextEncoder().encode("hello from cat\n"),
    deadlineMs: 10_000,
  });
  const { exit, stdout } = await command.result;
  if (exit?.kind !== "exited" || exit.code !== 0 || stdout.truncated)
    throw new Error("cat did not copy the full line");
  return new TextDecoder().decode(stdout.bytes);
}

const line = await copyLine(runtime);
```

`line` contains `"hello from cat\n"`. Use the same runtime for later commands. Its owner calls
`runtime.dispose()` when the page no longer needs it.

## Inputs and authority

Pass an absolute executable path. Waffle prepends it to `args` and applies any registered
argument override. `cwd` defaults to `/`, and `env` defaults to an empty record. Waffle snapshots
the arguments, environment, and input bytes at the call.

The explicit `filesystem: "runtime-root"` option grants the generic worker its usual root
preopen. The command inherits only the selected standard descriptors. Omitted stdin reads as
EOF. To leave a descriptor unbound, pass `"closed"` for that descriptor.

The command and its descendants can start and replace images only through registrations that
provide Wasm bytes and a guest adapter. The same rule applies through filesystem aliases.
Waffle loads and admits the bytes on demand. Importing the command entry and registering the
package leave process activation and the guest's Wasm load until execution.

## Output and completion

Waffle captures the first 64 KiB of stdout and stderr by default. Set `limitBytes` on either
output to change its cap. A zero cap discards capture. Each output reports `truncated` separately
from the exit result. An optional synchronous `onChunk` callback receives owned chunks as they
arrive, including bytes past the capture cap. For stdin streams, Waffle pulls one chunk at a
time and cancels the stream if stdin closes before it finishes.

The result preserves the leader's `exited`, `signaled`, or `start-failed` outcome.
`command.signal(n)` dispatches to the initial job. `command.kill()` and signal 9 stop the
command's process tree. `deadlineMs` requests that same stop when the elapsed time expires.
The first stop request is reported as `stopRequested`. If it wins before reserving the
leader, `exit` is `null`.

`kill()` returns the same promise as `result`. The promise settles after Waffle joins the
command's descendants and their native and I/O cleanup, drains committed output, and retires
the page root. Setup errors, user I/O errors, runtime disposal, and unconfirmed cleanup reject
the promise.
