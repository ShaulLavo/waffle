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
| 14   | `child_pipe` | `(child, selector) -> pipe_or_final_signal`                       |
| 15   | `child_kill` | `(child, signal) -> i32`                                         |
| 16   | `shutdown` | `(connection) -> i32`                                            |
| 17   | `local_addr` | `(handle, buf_ptr, buf_cap) -> len`                              |
| 18   | `signal`     | `(signal, mode) -> i32`                                         |

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

## Signal dispositions

Optional slot 18, `signal(sig, mode)`, connects Node/Bun signal listeners to the process host
without adding mandatory WebAssembly imports. ABI version 1 and slots 0–17 retain their meaning.
A plain preview1 host may leave the slot unset. The browser's ordinary WASI adapter also exposes
`runtime_proc.signal(sig, mode)` with the same operations.

- Modes 0, 1 and 2 synchronously set default, ignored and handled dispositions, respectively.
  Signal numbers are 1–64; SIGKILL (9) cannot be registered or ignored.
- Mode 3 raises a signal against this process's current disposition, including SIGKILL. It does
  not force the default action when a handler is registered.
- `(0, 0)` dequeues one pending handled signal, lowest signal number first; 0 means none.
  `runtime_proc.interrupted()` consumes that same queue, not a second copy. If signal death has
  already been selected, entering this checkpoint instead unwinds through that typed default
  action; an empty handled queue cannot hide a selected fatal outcome.
- Set/raise returns 0 on success; invalid arguments return -22. A selected default action may
  instead unwind the current execution through the host's typed signal termination path.

This layer supports SIGINT (2), SIGKILL (9), SIGPIPE (13) and SIGTERM (15). For a default
SIGINT/SIGTERM/SIGPIPE disposition, the supervisor immediately selects the signaled outcome,
revokes capabilities and requests termination. Ignored signals do nothing. Handled signals queue
without cancellation, so their handler can clean up and retain the guest's own exit code. SIGKILL
always selects 137 and cannot be caught or ignored. Registration and removal publish synchronously
with listener mutation, before user `removeListener` observers run. Removing a pending handler to
default immediately selects its default action; setting ignored clears the pending signal.

Browser/Node processes share 65 Int32 cells, indexed by signal number. The low two bits encode
the disposition and bit `0x4` records pending delivery. Atomic updates couple disposition and
pending state; distinct pending signals cannot overwrite one another, while repeats of one
standard signal may coalesce. Dequeue clears pending before a once-listener removes itself.
The existing interrupt word is only a wake hint. Native stores use the same disposition and
pending rules under their process-state synchronization. Polling/listener registration alone
does not keep an otherwise idle guest alive. Cooperative guest event-loop turns deliver handlers;
CPU-bound engine checkpoints remain step 7a. Unhandled default actions do not wait for that step.

An EPIPE remains an error through guest stream callbacks/listeners or try/catch. Plain preview1
programs retain the default SIGPIPE action, so a SIGPIPE request selects 141. The Node/Bun JS
runtime is different: it initializes SIGPIPE as ignored, lets an explicit `SIGPIPE` listener opt
into handled delivery, and restores default after the last SIGPIPE listener is removed. An escaping EPIPE keeps the
ordinary uncaught-error path and exits 1 with the error printed, even with a SIGPIPE listener; a
handled EPIPE keeps the guest's own status. Error handling never synthesizes SIGPIPE or consumes
unrelated pending signals. An explicit parent SIGPIPE request uses the target disposition immediately,
just like SIGINT or SIGTERM.

## Bun child processes

`spawn` returns a child handle without waiting for execution. The browser starts a fresh worker
using a registered compiled module and guest adapter; it never invokes a native executable.
The native launcher and Node adapter support their configured Bun executables. Metadata is JSON:

```json
{"argv":["bun","run","/app.ts"],"cwd":"/","env":{"HOME":"/"},
 "stdin":"pipe","stdout":"pipe","stderr":"pipe"}
```

The guest preserves `argv[0]`; executable selection belongs to the host's registry.
The browser registers `bun`, `/bun`, `node`, `/node`, `/usr/local/bin/bun` and
`/usr/local/bin/node` with the page/root command's selected engine and compiled module.
`bun-quickjs`, `bun-jsc` and `bun-browser` select an engine explicitly. Generic aliases keep
using the page/root engine even when an explicitly selected child uses another engine.
A browser start failure appears through `child_wait`: 127 for an
unregistered executable, 126 for a registered executable that cannot start.
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

Slot 14 also reserves the named selector `CHILD_FINAL_SIGNAL = 3`:
`child_pipe(child, 3)` returns `AGAIN` until completion is published, then 0 for
an ordinary exit or the signal number for a selected signal death. An unknown
child or unsupported selector returns `BADF`. This is a metadata query, not a pipe
handle, and does not allocate or close a descriptor. Slots 12–15 retain their
numbers and integer signatures; selectors 0–2 retain their existing meaning.
The guest reads the final signal after `child_wait` completes and before closing
the child. Both queries remain repeatable. Status 143 alone never implies SIGTERM:
ordinary `process.exit(143)` reports `exitCode: 143, signalCode: null`, whereas
selected SIGTERM reports `exitCode: null, signalCode: "SIGTERM"`. Signal requests
and timeout flags do not classify the final outcome.

Separate-guest workers use two additional control-pipe selectors, without reusing
signal metadata selector 3. Selector 4 is parent-to-worker input (parent writes,
worker reads); selector 5 is worker-to-parent output (worker writes, parent reads).
The parent queries these with the worker's child handle; a worker queries its own
endpoints with child handle 0. Handle 0 does not turn selector 3 into a pipe or
provide root completion metadata. These private channels do not change stdio
selectors 0–2 or their inheritance modes. Native worker completion closes its incoming
reader and outgoing writer before publishing completion, so pending parent writes
observe EPIPE and readers can reach EOF.

`child_wait` is nonblocking and repeatable: `AGAIN` while running, then the exit
code. Waiting does not close the child or its pipes. Drain and close the pipes,
then `close(child)` to release the handle. Closing a running child kills it.
`child_kill(..., 0)` checks whether the child is alive. SIGINT, SIGTERM and SIGPIPE examine the
child's registered disposition: default immediately selects `128 + sig` and revokes; ignored
does nothing; handled queues delivery and preserves the guest's own exit code. An explicit
`runtime_proc.default_signal(sig)` also records a typed default action. SIGKILL immediately
selects 137 and revokes regardless of disposition. Late worker messages cannot override a
selected outcome. There are no escalation timers. Timeouts and abort signals use the same
operation; a prior request or timeout flag is not evidence of the eventual signal kind.

The native launcher shares the compiled module and preopened host directories
between independent stores on child threads. Filesystem changes are visible
immediately to both sides, as with native processes. A shared budget permits at
most four active children, including descendants; another spawn fails `EAGAIN`.
Each store's linear memory is limited to 512 MiB. A 10 ms epoch ticker interrupts
CPU-bound children; cancellation also wakes blocked WASI stdio and host polling.
Parent teardown kills and joins its remaining children, including descendants.
Handles are virtual identifiers, not host process IDs. Native process/pipe and
network handle ranges are disjoint and bounded; exhaustion returns `EAGAIN` before
creating a child, pipe or network operation, never a wrapped or misrouted handle.
Guest timer waits and `Bun.sleepSync` use host polling so cancellation also interrupts long sleeps.
A native unhandled signal selects typed signal death immediately; epoch, poll and stdio
checkpoints observe that selected cancellation to stop execution. A handled request instead
queues delivery without fatal cancellation, so an ordinary guest exit keeps its code.
SIGKILL selects signal 9 immediately if no outcome has already won. Selection is
immutable and precedes pipe closure and completion publication. A signal request
against a selected but not yet observed native child is a successful no-op, even
while publication is pending. Once a successful wait or final-signal query observes
completion, further native signal requests return `BADF`; the completion metadata
remains available for repeatable queries until `close(child)`.

Root and child stores share a native WASI `proc_exit` adapter that retains ordinary
exit codes 126–255 instead of Wasmtime's default trap for those values. It applies
the launcher's byte-sized OS exit convention (-1 becomes 255, 256 becomes 0), then
reports a typed ordinary exit. The browser WASI and host-JS engine exit adapters use the same
byte-sized convention, keeping negative values out of the child-control result namespace.
Thus `process.exit(143)` is an ordinary exit with status 143 and no signal, not a
trap or a SIGTERM result. The guest flushes buffered stdout before a blocking stdin
read, allowing the parent to wait for readiness output before sending input.

Browser and Node hosts implement the same process slots. The browser uses a page
broker to start child workers while their parent is blocked in `spawnSync`. The broker lazily
activates the generic process service on first spawn and shares compiled modules across workers.
Processes register independent identities with the live filesystem service; no snapshots or
merge-at-exit are used. Revocation is immediate at logical death. Before lock reaping and physical
termination, a shared critical-section admission fence proves host filesystem operations quiescent;
an ordinary guest exit acknowledgement also provides that proof. Merely calling
`Worker.terminate()` does not.
Node workers share their real preopens. See
[the browser host notes](../web/README.md#bun-subprocess-workers) for networking and isolation.

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
