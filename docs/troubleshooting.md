# Troubleshooting

Find the message you see, then follow the fix. Every message below was captured from a real run against the pinned commit in [Getting started](getting-started.md).

## The console says `SharedArrayBuffer is not defined`

The page is not cross-origin isolated. Waffle needs `SharedArrayBuffer`, and browsers only expose it on isolated pages. `createRuntime()` can also throw `Page runtime requires SharedArrayBuffer and cross-origin isolation`.

1. Run `crossOriginIsolated` in the console. It must print `true`.
2. Make the server send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the page response.
3. Serve over HTTPS or from `localhost`. A `file://` page has no response headers to set.

## `Filesystem worker failed: uncaught error`

`runtime.filesystem.state.status` is `"failed"` and every file operation rejects with this message. The filesystem worker did not start. The usual cause is a `workerURL` that does not match your build output, such as `/nope.js` when the bundle is `/fs-worker.js`.

1. Open the network tab and look for a 404 on the worker URL.
2. Check that your build includes the entry `import "waffle/browser/fs-worker";` and that `workerURL` points at its output.

## `Cannot find module .../waffle/dist/core/index.js`

This happens in Node, not in a browser bundle. `bun install` printed `Blocked 1 postinstall` because the consumer did not trust Waffle, so `prepare` never wrote `dist/`. Browser bundlers read the TypeScript source and are not affected.

Add `"trustedDependencies": ["waffle"]` to `package.json`, or run:

```sh
bun pm trust waffle
```

## `A live page runtime already owns this page`

A page can have one runtime. You called `createRuntime()` again before the first runtime's `dispose()` finished. This happens often with hot module reload. Await `runtime.dispose()` before you create the next runtime.

## `Program name must be an absolute canonical file path`

`registerProgram("bun", ...)` rejects a bare name. Use an absolute path without dot segments, such as `/bin/bun`, and create the file at that path with `runtime.filesystem.writeFile` before you spawn. The full message ends with `for example /bin/bun; create its file with runtime.filesystem.writeFile before spawning`.

## A spawn ends with `start-failed`

Read the `error` field of the result:

| `error`  | Meaning                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENOENT` | No file exists at the executable path. Shell status 127.                                                                                       |
| `EACCES` | The path is a directory, or a file with no registered program. Shell status 126.                                                               |
| `EIO`    | The adapter's launcher threw. `launchWorker` throws `process has no admitted worker transport` for a root made with `supervisor.createRoot()`. |

[Run a WASI program](guides/run-a-wasi-program.md) shows a working root and the `ENOENT` case. Other startup errors are listed in [Host ABI](host-abi.md).

## `Unsupported VFS mode: safe`

`mode: "safe"` throws `VfsError` with code `UNSUPPORTED_VFS`. SAFE is reserved and has no fallback. Use `"fast"` or `"memory"`. See [Filesystem modes](vfs.md).

## Files are gone after a reload

- `mode: "memory"` keeps nothing. Use `mode: "fast"` and a stable `name`.
- With `mode: "fast"`, a write reaches IndexedDB at a checkpoint or at `await runtime.filesystem.flush()`. Closing the tab right after a write can lose it. Await `flush()` first.

[Persist the filesystem](guides/persist-the-filesystem.md) has a page that survives reloads.

## One tab stops working after another tab opens

The default `whenBusy` is `"takeover"`. The newest tab steals the workspace and the old tab's state changes to `"failed"` with `ownershipLost` set to `true`. Pass `whenBusy: "wait"` to make the new tab queue instead. A frozen or hidden owner tab can hold the lock indefinitely, so a waiting tab can wait for a long time. See [Storage](storage.md).
