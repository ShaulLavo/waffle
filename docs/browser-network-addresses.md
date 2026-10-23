# Browser TCP addresses

Browser TCP listeners belong to a runtime-local virtual loopback network, not an
operating-system interface. A listener retains its bind address and family.
`localAddr()` on a connected socket reports its concrete virtual endpoint, not
the listener wildcard. `peerAddr()` reports the other virtual endpoint.

Supported binds are `127.0.0.1`, `0.0.0.0`, `::1`, and `::`. IPv6 loopback and
unspecified addresses also accept expanded notation and report canonical text.
`localhost` selects IPv4 loopback. An empty bind retains the existing IPv4-any
default. Other hosts return `UNSUPPORTED` with `ENOTSUP`; no interface, DNS lookup,
or external TCP listener is created.

An IPv4 bind accepts IPv4 connections. `::1` accepts IPv6 connections. `::` accepts
both families. Its accepted IPv4 sockets report IPv6 mapped loopback addresses,
`::ffff:127.0.0.1`, while the IPv4 client still reports `127.0.0.1`. Connections to
wildcard destinations use loopback in that destination family. A family mismatch
returns `ECONNREFUSED` before allocating a socket or client port.

Each port still has one runtime-wide reservation across both families. Binding
the same port to separate IPv4 and IPv6 listeners is not supported. Standalone
hosts keep their existing per-host pipes and use the same address rules.

Host-side preview connections choose the listener's virtual loopback family.
These addresses describe the preview bridge, never the physical HTTP visitor's
IP address. The preview router selects listeners by virtual port. Guest HTTP fetches instead
retain their URL destination family, including mapped IPv4 accepted endpoints. An
incompatible destination returns a terminal `ECONNREFUSED` fetch error without
allocating a connection or falling through to the external fetch transport.

The internal `tcp-connect` request carries the destination host. Connection ring
records carry both `local` and `peer` addresses. Hosts and helpers must use the
same protocol. Fetch still uses the injected transport for external requests.
