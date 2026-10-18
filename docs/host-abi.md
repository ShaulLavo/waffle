# Waffle host ABI

Waffle exposes browser-side capabilities to WebAssembly guests without requiring a second runtime owner. The page creates one `createRuntime()` instance, and workers receive borrowed filesystem and process capabilities through explicit bootstrap messages.

## Ownership

`SharedFilesystem` owns the worker, storage backend, identity allocator and service lifetime. A process receives a `FilesystemIdentity` and descriptor bindings; it never receives the page's filesystem owner or its disposal method. `Runtime.dispose()` fences admitted filesystem work, stops consumers only after quiescence, closes owned services last, and releases the duplicate-bundle ownership guard.

## Process admission

`BrowserProcessBroker` reserves identities and descriptor bindings synchronously, then activates the lazy supervisor. Worker bootstrap receives a compiled module, argv, environment, filesystem connection and optional process transport. Source bytes must pass interruption admission; a precompiled module is accepted only with explicit cooperative execution.

## Process identity import

`runtime_proc.getpid: () -> i32` returns the calling process's own positive runtime PID,
not its parent PID or job ID. `ProcessABI` reads its already-bound `options.pid` directly;
the call takes no arguments, reads no guest memory, never waits and sends no service or
broker request. In-process and worker adapters expose the same import. It adds no eager
process-service activation, helper export or RPC operation.

## Executable access queries

`runtime_proc.access_start(path_ptr, path_len, cwd_ptr, cwd_len, mode)` copies both UTF-8
strings before returning. `cwd` must be absolute and `mode` must be X_OK (`1`); other modes,
invalid UTF-8, empty strings and NUL bytes return `-EINVAL` (`-28`). The returned positive
request ID belongs to the calling process. `access_take(request)` is `-EAGAIN` (`-6`) until
the asynchronous registry/filesystem check publishes, then consumes the request and returns
zero or `-ENOENT` (`-44`), `-EACCES` (`-2`), or `-ENOTDIR` (`-54`). `access_cancel` retires
ownership and causes a late completion to be discarded. Unknown or consumed IDs return
`-EBADF` (`-8`). There are at most 64 live requests per process, and process death retires
all of them. Queries call the same live `ExecutableRegistry.check(name, cwd)` used by spawn,
without activating the module loader, supervisor, filesystem descriptors, or process launch.
The result is point-in-time: spawn checks the live file and registration again, so an earlier
success cannot authorize an unlinked or unregistered program. Other filesystem failures retain
their WASI errno (unexpected failures are EIO, never invented ENOENT).

The process broker owns these requests because the filesystem worker has no executable registry.
Reusing filesystem request kind 3 would couple storage to the optional process/module graph.
Request maps and completion cells are created only on first use; there is no registry snapshot.
The imports never await, call `Atomics.wait`, compile, spawn, or allocate descriptors.

Poll kind 5 subscribes to an executable query request ID. The broker stores the result before
publishing completion and increments the process directory's common wake sequence only after
publication, so a completion racing `poll` cannot be lost. Cancellation and process death do
not publish a late completion.

## Transport contracts

Filesystem and process transports use shared-memory completion and readiness words plus message-port control. Descriptor bindings retain independent capability pins while duplicate bindings may share an open-file cursor. Termination selects one atomic outcome; cleanup acknowledgement and filesystem quiescence are separate facts.

Process startup failures use a third atomic outcome tag. `ENOENT` carries code 2,
`EACCES` carries code 13, and both have `status: null`; ordinary exits 126 and 127
remain ordinary exits. `runtime_proc.wait` and `wait_job` map the typed outcomes to
127 and 126 while preserving the typed result for browser and host adapters.
The initial worker request carries the authoritative outcome view before any
dynamic process import. Startup errors select typed EACCES; after WASI execution
begins, failures retain an ordinary execution exit.
The instantiate phase and executor ready hook run only after validating the
callable `_start` export and the exported WebAssembly memory. A later exit notice
or numeric completion cannot replace the atomic typed startup outcome.

## Network and preview

The network helper performs injected `fetch` operations and writes responses to a shared ring. The host side exposes nonblocking handles and preview HTTP framing. Preview routing and service-worker registration are consumer policies; Waffle exports the routing and protocol services without choosing a URL scope.

## Compatibility

Waffle does not promise compatibility with an older runtime package or a stale consumer. Consumers pin one exact Git commit and use the matching exports and lockfile.
