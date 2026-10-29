# Network module ABI

`waffle/network` exposes `loadNetworkModule(url?)`. The default URL is `network.wasm` beside the loader. Loading compiles bytes. `create(io?)` creates an independent owner; the default OS import returns `Unsupported`. `dispose()` is terminal and idempotent for that owner.

## Memory and calls

The module exports unshared memory, `tcp_buffer()` and `tcp_capacity()`. The scratch buffer holds 64 KiB. Callers copy input before an operation and copy output before another operation. The host import must not retain pointers, call module exports reentrantly, or use memory after returning. The fixed scratch ABI takes lengths but no caller-selected pointers, so it needs no public allocate/free pair. Invalid or oversized lengths fail before changing state. Native import pointers and lengths are checked against the supplied memory; address operations require exactly 32 bytes. Memory growth can replace its buffer. The loader refreshes views on each call and returns owned output copies.

All tokens are positive `u32` values below `i32::MAX`. Zero is not a socket. Tokens belong to one instance and must not cross namespaces. Native adapters issue monotonically increasing tokens and do not reuse closed tokens. The module quarantines every issued native token until the instance is destroyed, including after raw `tcp_dispose()`. A reused token fails with `InvalidInput`; a duplicate active token does not close the live resource. The quarantine costs one set entry per issued native token. Delayed readiness for a closed token makes no host call.

Results are nonnegative byte counts or tokens, or a negative error kind. Errors are `-1 WouldBlock`, `-2 InvalidInput`, `-3 AddrInUse`, `-4 AddrNotAvailable`, `-5 ConnectionRefused`, `-6 BrokenPipe`, `-7 NotConnected`, `-8 PermissionDenied`, `-9 TimedOut`, `-10 Unsupported`, `-11 ConnectionReset`, `-12 ConnectionAborted`, `-13 Other`, `-14 HostUnreachable`, `-15 NetworkUnreachable`, and `-16 NetworkDown`. They are transport classifications, not Bun JSON or OS error strings. The calling operation and input address supply syscall and target context.

Addresses occupy 32 bytes. Little-endian `u32` fields hold family at offset 0 and port at offset 4. Network-order IP octets start at offset 8. IPv6 uses all 16 octets, flowinfo at offset 24, and scope ID at offset 28. IPv4 uses four octets and zeroes the remaining fields.

## Native operations

`tcp_listen_default(port)` explicitly requests IPv6-any, dual-stack, with IPv4 fallback for unavailable IPv6. It does not select a browser or Bun default. `tcp_listen()` and `tcp_connect()` read a binary address from scratch. `tcp_accept(listener)` returns a new stream token. `tcp_local_addr(id)` and `tcp_peer_addr(id)` write an address to scratch and return `32`, the number of bytes written; read those results through the loader's public `read(name, id, 32)` method. The `address()` helper remains reserved for browser virtual-network metadata.

`tcp_read(id, length)` copies available bytes into scratch. `tcp_write(id, length)` accepts a prefix from scratch into a bounded queue. Neither count is a complete message. `tcp_shutdown(id)` schedules write shutdown after queued data drains. `tcp_close(id)` releases immediately. `tcp_dispose()` releases all resources.

`tcp_interests(id)` returns the needed OS readiness bits, readable 1 and writable 2. Failed streams return terminal bit 4 and need no wait. Drained write queues stop requesting writable readiness, so idle sockets do not busy-loop. `tcp_poll(id)` advances one bounded nonblocking turn. The native event loop waits for read, write, connect, accept, or terminal readiness outside WASM, then invokes the appropriate export. The reference Unix host has `wait_ready(id, interests, timeout)`, with readable bit 1, writable bit 2, and terminal bit 4. It does not spin a WASM thread or require a no-op waker. Consumers must continue driving queued writes even after a successful write call.

The sole import is `waffle_tcp_host.io(operation, token, pointer, length) -> i32`. `network/src/abi.rs` defines operation numbers. `NativeHost.dispatch` validates spans before performing OS operations. Its `socket2` sockets are nonblocking, and IPv6-any explicitly disables `IPV6_V6ONLY`.

Native outgoing and accepted connections enable TCP_NODELAY. Unix listeners use SO_REUSEADDR so a released listener can be rebound while accepted streams remain alive.

## Browser virtual commands

`net_listen(kind, port)` reserves a virtual port. Kind 4 means IPv4 loopback, 40 IPv4-any, 6 IPv6 loopback, and 60 IPv6-any. `net_connect(kind, port)` creates paired endpoint tokens; `net_peer(id)` finds the other endpoint. Other kinds are unsupported. Rust rejects real interfaces.

`net_pair()` creates an addressless connected pair for pathname sockets and returns the dialing token; it uses no port, and `net_address` on either token is unsupported.

`net_write`, `net_take`, `net_consumed`, `net_writable`, `net_ended`, `net_shutdown`, `net_close`, `net_address`, and `net_unlisten` support the existing helper callbacks. Taking bytes for ring publication does not release credit. Guest consumption releases credit and generates the existing writable event. Each direction permits 1 MiB outstanding. Closed tokens ignore late credit receipts. Accepted sockets survive listener removal.

The native write queue retains PR116's 1 MiB high-water mark and 64 KiB minimum acceptance when any room remains. Read queues stop at 1 MiB. Browser virtual credit remains strictly 1 MiB to preserve its existing contract.

## Native multi-socket driving and graceful close

On Unix, `native::Readiness::new()` returns an actor-owned readiness endpoint and a cloneable `ControlWake`. `NativeHost::wait_many(&[(token, interests)], &mut readiness, timeout)` waits on all selected sockets and the control endpoint in one `poll`. `Ready.sockets` carries token/readiness-bit pairs. `Ready.control` reports a consumed control wake. `None` waits without a deadline. A finite timeout is the caller's deadline, not a polling interval. A wake sent before the wait stays pending. Multiple wakes can coalesce.

One native actor owns the module store and `NativeHost`, including while it waits. Other threads send commands through the consumer's queue and then call `ControlWake::wake()`. They do not lock or call the store. After control wake, the actor consumes commands, recomputes module interests, and waits again. Fetch, process, cancellation, and disposal commands use that same wake. No Waffle engine thread or production Wasmtime dependency is required.

The following exports add graceful retirement without changing immediate `tcp_close`:

| Export                      | Result                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tcp_close_graceful(token)` | Stop further writes, discard buffered and future input, drain already admitted output, then send FIN. A pending connect continues on writable readiness.                                    |
| `tcp_close_status(token)`   | Bit 1 means the output queue drained and write shutdown succeeded. Bit 2 means graceful discard reached peer EOF. A negative result is a sticky transport failure, not successful flushing. |
| `tcp_next(after)`           | Return the next live native transport token greater than `after`, or zero. This includes private draining streams accepted while retiring a listener.                                       |

Status 1 lets a consumer's exit waiter observe writer completion without waiting for the peer to close its write side. Status 3 means both directions finished. At status 3, call `tcp_close` to release the transport token and socket. Failed tokens also require immediate close after the consumer records the failure. Completed streams request no OS readiness. The token quarantine still rejects stale notifications after removal.

Graceful listener retirement accepts queued peers until the nonblocking accept reports WouldBlock, starts their graceful drains, and releases the listener before returning. Already accepted streams survive. Enumerate the private drains through `tcp_next`; they do not need public guest handles. Immediate listener close retains its EOF-or-reset contract.

The consumer owns the drain deadline and expiry action. To retain bun-wasm's previous policy, keep discard reads alive for up to five seconds after close, and let normal exit wait up to its existing two-second writer deadline. Those are consumer choices, not clocks or timers inside WASM. At expiry, `tcp_close` releases the resource even if the peer never sends EOF. Graceful retirement clears receive high-water backpressure, so unread peer input cannot fill a dead guest's receive queue and prevent draining.

A consumer event loop enumerates native tokens, obtains fresh `tcp_interests`, handles terminal bit 4 without waiting, and passes only read/write interests to `wait_many`. Listener readiness calls `tcp_accept`; stream readiness calls `tcp_poll`. Continue driving writable readiness after successful `tcp_write`, even if the guest never writes again. Notify the consumer after progress and publish terminal observations once before retiring their registrations. Do not wait on buffered bytes, hold a store mutex during OS waits, or keep writable interest after a queue drains.

Disposal sends a stop command and control wake, joins the module actor, and calls `tcp_dispose` before dropping the store. Waffle retains no readiness thread, background socket task, pointer, or engine callback. The compiled-module fixture in `network/tests/module.rs` demonstrates this ownership with two connections, forced two-byte host I/O, writer completion, strict EOF, listener reuse, and joined cancellation. Browser owners still use only virtual commands with an unsupported OS import.
