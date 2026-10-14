# bun.wasm host ABI (`bun_wasm`, version 1)

WASI preview1 has no sockets. Hosts that want to give bun.wasm networking
(`fetch`, `Bun.serve`, `node:http`, `node:net`) provide a small set of extra
functions described here. Hosts that don't (plain `wasmtime run`) need to do
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

## Hosts

- `crates/bunwasm-host` (`bun-wasm` binary): native launcher on wasmtime,
  implements every slot.
- `web/`: the browser playground implements `poll`, `fetch*`, `read`,
  `close`, `error`, and (for `Bun.serve` previews) `listen`/`accept`/`write`
  on virtual connections fed by a service worker.
- `wasmtime run`: no slots; network APIs report "not supported".
