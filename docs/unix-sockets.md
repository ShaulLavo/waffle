# Unix-domain stream sockets

Guests of one runtime can listen on and connect to pathname stream sockets, such as
`/tmp/vite.sock`. The socket is a real node in Waffle's filesystem, and the bytes travel through
the same in-memory streams as loopback TCP. Nothing reaches the host operating system.

This is not Linux parity. The sections below list exactly what is supported and where it differs.

## Launcher setup

A trusted launcher gives each guest helper a path scope: the guest's own filesystem identity and a
directory its capability table holds.

```ts
const root = await runtime.filesystem.directoryHandle("/");
const pathScope = service.networkPathScope(context, root.handle);
const helper = network.createHelper({ ring, fetch, hooks, pathScope });
// Cleanup: helper.dispose(), then root.release().
```

`ProcessService.networkPathScope(context, directory)` returns the live admitted process's own
identity with `directory`. It throws for an unknown, mismatched, exited or revoked context.
Nothing is attached at that point. On the guest's first path request, the runtime checks that the
identity belongs to this runtime's filesystem and is live, and that the guest's table holds the
directory. A helper without a scope, or whose scope fails that check, gets `ENOTCAPABLE` for every
path call. Requests from the guest carry only a path string, never authority.

`helper.dispose()` stays synchronous. The runtime keeps any unlink it starts and finishes it before
the filesystem closes.

## Guest calls

Only shared hosts (`new NetHost(ring, send, writeFile, { shared: true })`) support paths. A
standalone host returns `UNSUPPORTED` with code `ENOTSUP`.

```ts
listenPath(path: string, options?: { readonly unlinkOnClose?: boolean }): number;
connectPath(path: string): number;
```

Both return a handle, or `ERROR` with `error(0)` set to `{ name, message, code, syscall }`. Every
other call is the existing one: `accept`, `read`, `write`, `shutdown`, `close`, `poll`, `error`,
`localAddr` and `peerAddr`. `localPort` on a path handle returns `UNSUPPORTED`.

`close` on a path listener waits until any requested unlink settles. It returns `OK`, or `ERROR`
with `syscall: "close"`. The handle is gone either way, and the runtime keeps retrying a failed
unlink.

Addresses are JSON `{ "family": "Unix", "path": string | null }`:

| Handle   | `localAddr`          | `peerAddr`           |
| -------- | -------------------- | -------------------- |
| listener | the bound path       | `BADF`               |
| accepted | the bound path       | `null` path          |
| client   | `null` path          | the connected path   |

## Names

- Paths must be absolute and at most 4096 UTF-8 bytes. They resolve inside the scope directory by
  walking the real tree, so symlinks, `.` and `..` are followed as stored, never folded as text.
- Bind creates a mode `0600` socket node exclusively. Any existing name, including a stale socket,
  fails with `EADDRINUSE`. Bind does not follow a final symlink.
- Connect follows a final symlink and needs write permission on the socket.
- `unlinkOnClose` defaults to `true`. Close removes the original name only while that name still
  points at this listener's socket. A renamed socket keeps working at its new name, and close does
  not chase it. A replacement at the original name is never removed.
- With `unlinkOnClose: false`, or after the runtime ends, the node stays as stale metadata:
  connect fails with `ECONNREFUSED` and bind with `EADDRINUSE` until something removes it.
- Helper disposal honors `unlinkOnClose`. A bind that finishes after its helper was disposed is
  rolled back.

## Streams and limits

- Each direction holds at most 1 MiB that the reader has not consumed. A full direction returns
  `AGAIN`, and the writer's ring gets a writable event when the reader consumes. Ring records are at
  most 64 KiB.
- `shutdown` ends one direction after the bytes already written; the other direction still flows.
- After a full close the peer reads the bytes already delivered, then EOF. Its next write fails
  with `EPIPE`.
- Closing a listener keeps accepted streams. Peers it had not accepted read EOF. Linux reports
  `ECONNRESET` to those peers.
- One runtime allows 128 path listeners and 128 path connections. A listener holds at most 64
  connections it has not accepted; the next connect fails with `ECONNREFUSED`. Exhaustion fails
  with `ENOBUFS` and creates nothing. A connection counts until both ends close.

## Errors

| Code           | When                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `EINVAL`       | NUL, unpaired surrogate, or a relative path                             |
| `ENOENT`       | empty path, missing name or parent                                      |
| `ENAMETOOLONG` | more than 4096 UTF-8 bytes                                              |
| `ENOTDIR`      | a parent is not a directory                                             |
| `EACCES`       | no search on a parent, no write on the parent (bind) or socket (connect) |
| `ELOOP`        | symlink loop                                                            |
| `ENOTCAPABLE`  | no path scope, a scope that failed its check, or a path leaving it      |
| `EADDRINUSE`   | the name exists                                                         |
| `ECONNREFUSED` | not a socket, no live listener, another scope root, or a full backlog   |
| `ENOBUFS`      | runtime listener or connection limit                                    |
| `ECANCELED`    | the helper or runtime shut down during the call                         |
| `ENOTSUP`      | standalone host                                                         |

## Not supported

Datagram and seqpacket sockets, abstract names, socket file descriptors passed between processes,
credentials (`SO_PEERCRED`), hard links to sockets, and any connection to a host socket.
