# @bun-wasm/runtime

Browser runtime layers, consumed as a local TypeScript package. The `./core` export is available
now. Filesystem, network, process and terminal implementations get their own `./fs`, `./net`,
`./proc` and `./term` entries as those plan steps land; core imports none of them.

```ts
import { Wasi } from "@bun-wasm/runtime/core";

const wasi = new Wasi({
  args: ["program"], env: {}, fs, preopens: { "/": "/" },
  stdout: bytes => output(bytes), stderr: bytes => errors(bytes), sleep,
});
const instance = new WebAssembly.Instance(module, wasi.imports(module));
const status = wasi.start(instance);
wasi.descriptors.dispose();
```

`fs` implements `FileSystem`; today's MemFS implementation lives in `web/src/fs.ts`. Its handles
are filesystem-owned identities, not paths, reported inode numbers, or concrete tree nodes. A handle
used by an open description must remain valid after rename or unlink. The host calls `retain`/`release` once per
open description, not per duplicate; a filesystem worker can use those calls to reclaim detached
files after their final open description closes. `resolve` walks the real tree relative to
a directory capability and returns a handle or positive WASI errno. Other path operations work
on that result, with no asynchronous interleaving between resolution and mutation. Reads and
writes use iovec views directly and return byte counts or negative WASI errno, like streams; failures
do not advance the shared cursor. Resize and timestamp updates return zero or positive WASI errno.
Path operations use positive errno (creation wraps errors to distinguish them from handles).
`readdir` produces one entry list per call. Future worker-backed
clients can implement this synchronous interface without changing preview1.

Every fd belongs to `wasi.descriptors`. A binding holds its own rights and optional preopen name;
it references an `OpenDescription` holding a file, directory, pipe or terminal resource. `dup`
shares file offset and append mode but copies rights. `inherit` retains before returning, so the
parent can close immediately. Close, replacement, `proc_exit` and table disposal drop references;
the final reference invokes the resource's release callback. A WASM `_start` that returns normally
keeps descriptors alive (Bun light continues on the host engine); the executor disposes them when
the run finishes or traps.

Pipe and terminal services implement `Stream`. I/O returns bytes or negative WASI errno; readiness
is level-triggered readable/writable/hang-up state. `poll_oneoff` rechecks blocked descriptors,
reports expired clocks alongside ready fds, and reports per-event capability/descriptor errors.
The synchronous host uses bounded sleeps while waiting; process services can later add shared
wakeups. Inject bound endpoints through `stdio` to replace the default terminal descriptions.
The existing Bun child transport still owns cross-process pipe closure until the process layer
supplies inherited endpoint reference counts.

Imports are limited to implemented `wasi_snapshot_preview1` names and explicit `namespaces`.
An unknown namespace/name fails at linking, rather than receiving a fabricated ENOSYS stub.
Imported memories must be supplied as `WebAssembly.Memory` values in their declared namespace;
the host uses that memory even when the guest does not re-export it. Bun's socket slot adapter
configures `hostCallFd` and `hostCall` from `web/`; no Bun networking code is pulled into core.

Plain Node consumers that only need the JavaScript memory helper use
`@bun-wasm/runtime/core/memory-views`, without loading the TypeScript WASI adapter. The repository's
unbundled headless hosts import that JavaScript source relatively, so native CLI tests do not require
installing playground dependencies.

Run `bun install`, `bun test`, and `bun run check` in this directory. The web/sandbox builds
consume the public entry, so their split output also exercises the package boundary.

The repository's web and sandbox applications select hoisted installs locally.
Native Bun 1.4.2 rejects `onResolve` paths containing `..`, including its own
isolated `file:../runtime` cache directory names. Hoisting keeps those paths out
of the build-plugin result while preserving the consumer's package exports.
