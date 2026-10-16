# bun.wasm host ABI (`bun_wasm`, version 1)

WASI preview1 has no sockets. Hosts that want to give bun.wasm networking
(`fetch`, `Bun.serve`, `node:http`, `node:net`) and bun child processes provide
the extra functions described here. Hosts that don't (plain `wasmtime run`) need to do
nothing: bun.wasm runs exactly as before and network APIs reject or throw
"not supported".

## Why not plain imports

A core wasm module cannot have optional imports: an unknown import makes
`wasmtime run` (and `WebAssembly.instantiate`) fail. So bun.wasm does **not
import** these functions. Instead the host *installs* them after
instantiation and before calling `_start`:

1. bun.wasm exports its function table as `__indirect_function_table`
   (growable) and a function `bun_wasm_host_slots() -> i32`.
2. `bun_wasm_host_slots()` returns a pointer `p` (in linear memory) to:

   | offset   | type  | meaning                                          |
   |----------|-------|--------------------------------------------------|
   | `p+0`    | `u32` | ABI version the guest speaks (`1`)               |
   | `p+4`    | `u32` | number of slots `N`                              |
   | `p+8+4i` | `u32` | slot `i`: table index of the host function, or 0 |

3. For every slot it implements, the host appends its function to the table
   (`table.grow(1, func)`) and stores the new index in the slot. Slots left
   at 0 mean "not provided"; the guest checks each slot before calling.
   A host may provide any subset (e.g. the browser has no `connect`).

Calling `bun_wasm_host_slots` before `_start` is safe (it only returns the
address of a static). Browsers cannot put a JS function into a table
directly; wrap it by instantiating a tiny module that imports the JS
functions and re-exports them (the exports are wasm functions and can be
stored in the table).

### Calling through an import

Some engines may reject a cross-module function in the guest's table: a call_indirect to it traps
with "signature does not match" (iOS Safari does this for functions of another module). For those, a host can
instead write `0xFFFFFFFF` into a slot. The guest then calls that slot through WASI's `sock_send`,
which every preview1 host already provides:

```
sock_send(fd = 0x7FFFB0B0, si_data = ptr to [slot, a, b, c, d] (5 × i32), si_data_len = 5,
          si_flags = 0, so_datalen = ptr to the i32 result) -> errno
```

The host answers with errno 0 and writes the slot's result. Unused arguments are 0. Any other errno
reads as `UNSUPPORTED`. The playground and sandbox use this by default (`web/src/net/trampoline.ts`,
`installHostSlotsViaImport`); `?slots=table` selects the table path for comparison.
`scripts/run.ts` uses it with `SLOTS=imports`.

## Conventions

- All parameters and results are `i32` (wasm32 pointers and lengths are
  `i32`). Every function has the exact signature listed; the guest calls them
  with `call_indirect`, so a mismatch traps.
- Buffers are `(ptr, len)` pairs in the guest's linear memory.
- Handles are positive `i32`s chosen by the host, unique per process and
  never reused while open. `0` is never a valid handle.
- Results `>= 0` are success. Negative results are errors:

  | code | name          | meaning                                                  |
  |------|---------------|----------------------------------------------------------|
  | `-1` | `ERROR`       | failed; `error(handle, …)` describes why                 |
  | `-2` | `AGAIN`       | would block; try again after `poll`                      |
  | `-3` | `BADF`        | unknown or closed handle                                 |
  | `-4` | `UNSUPPORTED` | the host doesn't do this (e.g. `connect` in a browser)   |

- **Nothing blocks except `poll`.** The guest's event loop calls the
  non-blocking functions; when everything returns `AGAIN` and no JS timer is
  due, it calls `poll(timeout)` to sleep until the host has news.
- Text is UTF-8. Structured data is UTF-8 JSON.

## Slots

| slot | name         | signature                                                        |
|------|--------------|------------------------------------------------------------------|
| 0    | `poll`       | `(timeout_ms) -> i32`                                            |
| 1    | `fetch`      | `(meta_ptr, meta_len, body_ptr, body_len) -> handle`             |
| 2    | `fetch_head` | `(handle, buf_ptr, buf_cap) -> len`                              |
| 3    | `read`       | `(handle, buf_ptr, buf_cap) -> n`                                |
| 4    | `write`      | `(handle, buf_ptr, len) -> n`                                    |
| 5    | `close`      | `(handle) -> i32`                                                |
| 6    | `listen`     | `(host_ptr, host_len, port) -> handle`                           |
| 7    | `local_port` | `(handle) -> port`                                               |
| 8    | `accept`     | `(listener) -> handle`                                           |
| 9    | `connect`    | `(host_ptr, host_len, port) -> handle`                           |
| 10   | `error`      | `(handle, buf_ptr, buf_cap) -> len`                              |
| 11   | `peer_addr`  | `(handle, buf_ptr, buf_cap) -> len`                              |
| 12   | `spawn`      | `(meta_ptr, meta_len) -> child`                                  |
| 13   | `child_wait` | `(child) -> exit_code`                                          |
| 14   | `child_pipe` | `(child, fd) -> pipe`                                            |
| 15   | `child_kill` | `(child, signal) -> i32`                                         |
| 16   | `shutdown` | `(connection) -> i32`                                            |
| 17   | `local_addr` | `(handle, buf_ptr, buf_cap) -> len`                              |

### `poll(timeout_ms) -> i32`

Block until some handle may have changed state (a response head or body
bytes arrived, a connection is ready to accept, bytes are readable, a peer
closed, a write can proceed, an error happened) or `timeout_ms` elapsed.
`timeout_ms < 0` waits forever; `0` returns at once. Returns `1` if it woke
for an event, `0` on timeout. Spurious wake-ups are allowed: the guest
re-checks its handles either way. The host must not report the same
already-consumed event forever (`poll` may return 1 only when something new
happened since the previous `poll` returned).

### `fetch(meta_ptr, meta_len, body_ptr, body_len) -> handle`

Start an HTTP request. `meta` is JSON:

```json
{ "method": "POST", "url": "https://example.com/x",
  "headers": [["content-type", "text/plain"], ["x-a", "1"]],
  "redirect": "follow" }
```

`body` is the raw request body (`body_len` may be 0; ignored for GET/HEAD).
`redirect` is `"follow"` (default), `"manual"` or `"error"`. Returns a handle
at once; the request proceeds in the background. Errors that are known
immediately (malformed URL, unsupported scheme) may be returned as `-1` with
`error(0, …)` describing them.

### `fetch_head(handle, buf_ptr, buf_cap) -> len`

`AGAIN` until the response head is available. Then writes JSON:

```json
{ "status": 200, "statusText": "OK", "url": "https://example.com/x",
  "redirected": false, "headers": [["content-type", "text/html"]] }
```

and returns its length. If the JSON is longer than `buf_cap`, nothing is
written and the needed length is returned (the guest retries with a bigger
buffer). Network failures (DNS, refused, TLS, CORS in browsers) return `-1`;
`error(handle, …)` then gives the reason. Headers keep their order; names are
lower-case; repeated headers appear as separate pairs.

### `read(handle, buf_ptr, buf_cap) -> n`

For a fetch handle: the response body (after `fetch_head` succeeded),
already decoded from `content-encoding` (gzip/br/deflate) by the host, like
browsers do. For a connection handle: bytes from the peer. Returns `n > 0`
bytes, `0` at end of stream, `AGAIN`, or `ERROR`.

Handle `0` reads the current guest's stdin without blocking. It uses the same
return values. A host that does not expose stdin through this interface returns
`UNSUPPORTED`; ordinary WASI stdin remains available. The native launcher polls
its stdin stream, and browser and Node workers expose their shared subprocess
stdin pipe. Host-engine workers keep a watcher active while stdin is pending.
Callback `fs.read(0, ...)` registers an I/O waiter for these reads.
Synchronous reads use the WASI descriptor without Rust stdin prefetching.
The native WASI adapter and host interface share one read-ahead buffer, so
synchronous and callback reads keep one position.

### `write(handle, buf_ptr, len) -> n`

Connection handles only. Queues up to `len` bytes; returns how many were
accepted (`0 < n <= len`) or `AGAIN` when the host's buffer is full. Hosts
should accept at least 64 KiB per call when idle.

### `close(handle) -> i32`

Close any handle (fetch: abort the request; listener: stop listening;
connection: flush queued writes, then close). Returns 0 or `BADF`.

### `listen(host_ptr, host_len, port) -> handle`

Listen for TCP connections on `host:port` (`host` like `"0.0.0.0"`,
`"127.0.0.1"`, `"localhost"` or `"::"`; `port` 0 picks a free port).
Returns a listener handle or `ERROR` (e.g. `EADDRINUSE`, see `error`).

### `local_port(handle) -> port`

The port a listener (or connection) is bound to.

### `accept(listener) -> handle`

A new connection handle, or `AGAIN` when none is pending.

### `connect(host_ptr, host_len, port) -> handle`

Open a TCP connection (for `node:net` clients). Returns a handle at once;
`write` returns `AGAIN` until connected, `read`/`write` return `ERROR` if
the connection failed.

### `error(handle, buf_ptr, buf_cap) -> len`

JSON describing the last error on `handle` (or the last handle-less error
for handle `0`), same length protocol as `fetch_head`:

```json
{ "name": "TypeError", "message": "Failed to fetch", "code": "ECONNREFUSED" }
```

`code` is optional (a POSIX-style code such as `ECONNREFUSED`,
`EADDRINUSE`, `ENOTFOUND`, `ETIMEDOUT`).

### `peer_addr(handle, buf_ptr, buf_cap) -> len`

JSON `{ "address": "127.0.0.1", "port": 51234, "family": "IPv4" }` for a
connection, same length protocol as `fetch_head`.

## Bun child processes

`spawn` starts a fresh instance of the same compiled module. It never invokes a
native executable or shell. The metadata is JSON:

```json
{"argv":["bun","run","/app.ts"],"cwd":"/","env":{"HOME":"/"},
 "stdin":"pipe","stdout":"pipe","stderr":"pipe"}
```

`argv[0]` must be `bun` or `/bun`. The guest recognizes its own `process.execPath`
and `process.argv0`, then sends `bun`. Other commands fail with `ENOENT`.
`env` replaces the child environment; the host sets `PWD` to `cwd` because the
WASI guest changes directory there at startup. Each stdio mode is `pipe`,
`inherit`, or `ignore`. Inheritance refers to the immediate parent's stream,
including pipes when the parent is itself a child. No OS descriptor inheritance
or IPC channel is implied.

`child_pipe(child, fd)` returns the stdin, stdout, or stderr pipe for fd 0, 1, or
2. It returns 0 for an inherited or ignored stream. Use the existing `write`,
`read`, and `close` functions on these pipe handles. Closing stdin sends EOF;
closing an output read end discards remaining output and makes child writes fail.
Reads return `AGAIN` until bytes or EOF arrive. Pipe buffers are bounded to 1 MiB
on the native launcher and apply backpressure.

`child_wait` is nonblocking and repeatable: `AGAIN` while running, then the exit
code. Waiting does not close the child or its pipes. Drain and close the pipes,
then `close(child)` to release the handle. Closing a running child kills it.
`child_kill` accepts a Linux signal number; 0 checks whether the child is alive,
and a nonzero signal terminates the instance with exit code `128 + signal`.
This is instance termination, without guest POSIX signal handlers. Timeouts and
abort signals use this same operation.

The native launcher shares the compiled module and preopened host directories
between independent stores on child threads. Filesystem changes are visible
immediately to both sides, as with native processes. A shared budget permits at
most four active children, including descendants; another spawn fails `EAGAIN`.
Each store's linear memory is limited to 512 MiB. A 10 ms epoch ticker interrupts
CPU-bound children; cancellation also wakes blocked WASI stdio and host polling.
Parent teardown kills and joins its remaining children, including descendants.
Handles are virtual identifiers, not host process IDs. Guest timer waits and
`Bun.sleepSync` use host polling so cancellation also interrupts long sleeps.

Browser and Node hosts implement the same process slots. The browser uses a page
broker to start child workers while their parent is blocked in `spawnSync`. Its
filesystem is copied at spawn and changed paths merge back on normal exit, with
an 8 MiB serialized change limit. Node workers share their real preopens. See
[the browser host notes](../web/README.md#bun-subprocess-workers) for sync-back,
networking and isolation details.

The guest exposes Bun spawn APIs and Node spawn/exec/fork wrappers over these
slots. Fork launches a bun child; IPC channels and native descriptors are not
implemented. Shell execution accepts a single quoted bun command, without shell
operators or expansion. `$` remains unsupported.

Plain `wasmtime run` has no child slots and reports that spawning is not supported
in bun-wasm. It never falls back to a native program.

## Hosts

- `crates/bunwasm-host` (`bun-wasm` binary): native launcher on wasmtime,
  implements every slot.
- `web/`: the browser playground implements `poll`, `fetch`, `fetch_head`,
  `read`, `close`, `error`, and for `Bun.serve` previews `listen`,
  `local_port`, `accept`, `write` and `peer_addr` on virtual connections fed
  by a service worker (`/__preview/<port>/…`). `connect` works only to the
  guest's own listeners (an in-worker pipe); anything else is `UNSUPPORTED`.
  Requests are relayed through a SharedArrayBuffer ring (web/src/net/), so
  the page must be cross-origin isolated; without isolation no slots are
  installed. `scripts/run.ts` offers the same slots when running the shim
  in Bun.
- `wasmtime run`: no slots; network APIs report "not supported".


## TCP half-close and local addresses

`shutdown(connection)` flushes bytes already accepted by `write`, then sends FIN
on that connection's write direction. The handle remains open for reads. A
second shutdown succeeds without sending another FIN. `close` releases the
handle after both directions are no longer needed.

`local_addr` uses the same JSON and buffer protocol as `peer_addr`. It accepts
listeners and connections and returns `AGAIN` while an outbound connection is
still opening. An empty `write` on a connecting handle returns `AGAIN`, zero
after the connection opens, or `ERROR` on connection failure. It does not send
data. The guest uses this to delay the Socket connect event until success.

All browser engines support raw TCP only between listeners and clients inside
the same guest worker. An absent loopback listener fails with `ECONNREFUSED`.
An outbound internet TCP connection fails with `ENOTSUP`; browsers provide no
raw socket API. HTTP previews and WebSocket relays still use the existing host
bridge. TLS and Unix sockets are outside this adapter.
