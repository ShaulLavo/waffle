# @bun-wasm/runtime

Browser runtime layers, consumed as a local TypeScript package. `./core` and `./fs` are available
now. Network, process and terminal implementations get their own `./net`, `./proc` and `./term`
entries as those plan steps land; core imports none of them.

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

`FilesystemClient` from `./fs` implements `FileSystem`; the direct memory backend lives in
`runtime/fs/memory.ts` and is also exported as `./fs/memory`. Its handles
are filesystem-owned identities, not paths, reported inode numbers, or concrete tree nodes. A handle
used by an open description must remain valid after rename or unlink. The host calls `retain`/`release` once per
open description, not per duplicate; a filesystem worker can use those calls to reclaim detached
files after their final open description closes. `resolve` walks the real tree relative to
a directory capability and returns a handle or positive WASI errno. Other path operations work
on that result, revalidating it against concurrent path changes. Reads and
writes return byte counts or negative WASI errno, like streams; failures
do not advance the shared cursor. Resize and timestamp updates return zero or positive WASI errno.
Path operations use positive errno (creation wraps errors to distinguish them from handles).
`append` selects EOF and writes the complete iovec atomically, returning both committed bytes and
the resulting description offset. `create` carries exclusivity so competing nonexclusive creators
open the same current entry instead of replacing it or failing spuriously.
`readdir` produces one entry list per call. The blocking worker adapter implements this interface
with `Atomics.wait`, without changing preview1.

## Shared filesystem service

One filesystem worker runs `installFilesystemWorker(self)` and owns a `MemoryBackend`. Its
serialized `execute` boundary accepts asynchronous backends, but this step has no persistence.
The page, editor and every guest share that tree; completed writes are visible before exit.

Ports schedule requests; each request owns a SharedArrayBuffer with a 32-byte completion header,
JSON operation/arguments and optional binary input. Results overwrite the data region. Large
results are read in 64 KiB pieces, not placed in a fixed-size process snapshot. A completion owns
its buffer until `release()`; buffers and revocation words are never recycled between guests.

```ts
const request = client.submit("read", [handle, 4096, 0]); // does not block
client.readiness(request.id); // { kind: 3, id, ready } for a future process poller
try {
  const bytes = await request.value();
} finally {
  request.release();
}
```

`ready`, `epoch`, `wait()`, `value()`, `cancel()` and `release()` are exposed on the completion.
The connection's shared `signal` changes on completion/cancellation so a future poller can
recheck readiness. No `runtime_proc` imports are implemented here. Read, stat and resolved-path
caches are bounded and validated by the shared mutation epoch. Retained open files read and
write shared pages directly when capacity is already allocated; neither operation needs a port
round trip. In-capacity appends select EOF and write atomically in the guest too; namespace edits and growth
remain service-owned. A direct read takes the file's lock once, checks revocation once while holding it,
and copies straight into the guest's buffers; writes and appends also hold the global mutation lock,
so the epoch stays odd until their bytes, size and timestamp are in place. Cached opens/closes use per-connection shared reference counts, while the
service alone owns backend pins. Preopens and open descriptions retain handles; transient path pins
are bounded and evicting them invalidates cached paths.

The service owns the page allocator and grows capacity geometrically in 64 KiB pages, across
16 MiB growable SharedArrayBuffer segments. Connections carry the zero-byte segment references
before execution; only the service grows their backing storage. A synchronous guest therefore
sees completed growth without returning to its event loop or receiving another port message.
`createFilesystemIdentity(undefined, maxBytes)` configures
the pool cap (1 GiB by default, rounded to whole segments); an individual file supports 256 pages
(16 MiB). A full pool reports WASI ENOSPC; exceeding the per-file limit reports EFBIG.
`resources()` reports allocated backing bytes, data-pool and metadata bytes (including private
capability tables), used/free bytes, the configured cap, and registered identities. Zero-byte
segment references do not count as allocated backing storage. Grown segments are retained
for page reuse until the filesystem is disposed.

Connections carry their own revocation word and every ancestor's word, plus a shared ancestry
wake signal. Blocking waits recheck revocation after a signal change; asynchronous values use
one `Atomics.waitAsync` watcher per active client alongside ordinary port notifications. The page
revokes a killed guest, sweeps the service and terminates it; no service operation waits for a
guest acknowledgment. A filesystem-worker error revokes the root and wakes all descendants,
so an absent completion message cannot strand a guest or page startup.
When a blocked guest spawns a child, it creates only a `FilesystemIdentity`. The runnable page
uses `connectFilesystemIdentity` to create the MessageChannel and attach the service endpoint,
then transfers the client endpoint to the child. Creating a new channel in a blocked guest
would deadlock Firefox. `createFilesystemConnection`/`client.fork()` are for runnable controllers
and non-blocking setup, not that guest spawn path.

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
