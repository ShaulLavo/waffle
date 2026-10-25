# Network module ABI

`waffle/network` exposes `loadNetworkModule(url?)`. The default URL is `network.wasm` beside the loader. Loading compiles bytes. `create(io?)` creates an independent owner; the default OS import returns `Unsupported`. `dispose()` is terminal and idempotent for that owner.

## Memory and calls

The module exports unshared memory, `tcp_buffer()` and `tcp_capacity()`. The scratch buffer holds 64 KiB. Callers copy input before an operation and copy output before another operation. The host import must not retain pointers, call module exports reentrantly, or use memory after returning. The fixed scratch ABI takes lengths but no caller-selected pointers, so it needs no public allocate/free pair. Invalid or oversized lengths fail before changing state. Native import pointers and lengths are checked against the supplied memory; address operations require exactly 32 bytes. Memory growth can replace its buffer. The loader refreshes views on each call and returns owned output copies.

All tokens are positive `u32` values below `i32::MAX`. Zero is not a socket. Tokens belong to one instance and must not cross namespaces. Native adapters issue monotonically increasing tokens and do not reuse closed tokens. The module quarantines every issued native token until the instance is destroyed, including after raw `tcp_dispose()`. A reused token fails with `InvalidInput`; a duplicate active token does not close the live resource. The quarantine costs one set entry per issued native token. Delayed readiness for a closed token makes no host call.

Results are nonnegative byte counts or tokens, or a negative error kind. Errors are `-1 WouldBlock`, `-2 InvalidInput`, `-3 AddrInUse`, `-4 AddrNotAvailable`, `-5 ConnectionRefused`, `-6 BrokenPipe`, `-7 NotConnected`, `-8 PermissionDenied`, `-9 TimedOut`, `-10 Unsupported`, `-11 ConnectionReset`, `-12 ConnectionAborted`, and `-13 Other`. They are transport classifications, not Bun JSON or OS error strings. The calling operation and input address supply syscall and target context.

Addresses occupy 32 bytes. Little-endian `u32` fields hold family at offset 0 and port at offset 4. Network-order IP octets start at offset 8. IPv6 uses all 16 octets, flowinfo at offset 24, and scope ID at offset 28. IPv4 uses four octets and zeroes the remaining fields.

## Native operations

`tcp_listen_default(port)` explicitly requests IPv6-any, dual-stack, with IPv4 fallback for unavailable IPv6. It does not select a browser or Bun default. `tcp_listen()` and `tcp_connect()` read a binary address from scratch. `tcp_accept(listener)` returns a new stream token. `tcp_local_addr(id)` and `tcp_peer_addr(id)` write an address to scratch and return `32`, the number of bytes written; read those results through the loader's public `read(name, id, 32)` method. The `address()` helper remains reserved for browser virtual-network metadata.

`tcp_read(id, length)` copies available bytes into scratch. `tcp_write(id, length)` accepts a prefix from scratch into a bounded queue. Neither count is a complete message. `tcp_shutdown(id)` schedules write shutdown after queued data drains. `tcp_close(id)` releases immediately. `tcp_dispose()` releases all resources.

`tcp_interests(id)` returns the needed OS readiness bits, readable 1 and writable 2. Failed streams return terminal bit 4 and need no wait. Drained write queues stop requesting writable readiness, so idle sockets do not busy-loop. `tcp_poll(id)` advances one bounded nonblocking turn. The native event loop waits for read, write, connect, accept, or terminal readiness outside WASM, then invokes the appropriate export. The reference Unix host has `wait_ready(id, interests, timeout)`, with readable bit 1, writable bit 2, and terminal bit 4. It does not spin a WASM thread or require a no-op waker. Consumers must continue driving queued writes even after a successful write call.

The sole import is `waffle_tcp_host.io(operation, token, pointer, length) -> i32`. `network/src/abi.rs` defines operation numbers. `NativeHost.dispatch` validates spans before performing OS operations. Its `socket2` sockets are nonblocking, and IPv6-any explicitly disables `IPV6_V6ONLY`.

## Browser virtual commands

`net_listen(kind, port)` reserves a virtual port. Kind 4 means IPv4 loopback, 40 IPv4-any, 6 IPv6 loopback, and 60 IPv6-any. `net_connect(kind, port)` creates paired endpoint tokens; `net_peer(id)` finds the other endpoint. Other kinds are unsupported. Rust rejects real interfaces.

`net_write`, `net_take`, `net_consumed`, `net_writable`, `net_ended`, `net_shutdown`, `net_close`, `net_address`, and `net_unlisten` support the existing helper callbacks. Taking bytes for ring publication does not release credit. Guest consumption releases credit and generates the existing writable event. Each direction permits 1 MiB outstanding. Closed tokens ignore late credit receipts. Accepted sockets survive listener removal.

The native write queue retains PR116's 1 MiB high-water mark and 64 KiB minimum acceptance when any room remains. Read queues stop at 1 MiB. Browser virtual credit remains strictly 1 MiB to preserve its existing contract.
