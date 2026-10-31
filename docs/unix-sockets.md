# Unix-domain stream sockets

Guests of one runtime can listen on and connect to pathname stream sockets, such as
`/tmp/vite.sock`, and Linux abstract names, such as `"\0nitro-worker.sock"`. A pathname socket is
a real node in Waffle's filesystem; an abstract name lives only in the runtime's network. The bytes
travel through the same in-memory streams as loopback TCP. Nothing reaches the host operating
system.

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

| Handle   | `localAddr`    | `peerAddr`         |
| -------- | -------------- | ------------------ |
| listener | the bound path | `BADF`             |
| accepted | the bound path | `null` path        |
| client   | `null` path    | the connected path |

For an abstract name the path is the requested string, leading NUL included (`"\u0000name"` in
JSON).

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

## Abstract names

A name whose first UTF-16 unit is U+0000 is abstract. This is decided first, on the raw string;
every other name follows the pathname rules above, so a NUL anywhere else is `EINVAL`.

- Identity is the whole string, compared exactly. Later NULs are significant, nothing is trimmed,
  and there is no case or path folding. Its UTF-8 bytes are Linux's `sun_path` bytes.
- No normalization and no filesystem: no cwd join, no `.`, `..` or symlink processing, no node, no
  mode and no permission checks.
- The name, leading NUL included, is at most 108 UTF-8 bytes (`sizeof sun_path`). The empty name
  `"\0"` is `EINVAL`, because autobind is not supported.
- Scope is the runtime's network, the same reach as loopback TCP: every guest of the runtime shares
  it, and other runtimes cannot see it.
- They need a shared host, like pathnames. They do not use the path scope: a helper without one can
  bind and connect abstract names while its pathname calls still get `ENOTCAPABLE`.
- The listener owns the name. Closing it, disposing its helper or ending the runtime frees the name
  at once, so a new bind succeeds immediately. `close` never waits, and `unlinkOnClose` is accepted
  and ignored.
- Accepted streams survive listener close, and unaccepted peers read EOF, as with pathnames.

## Streams and limits

- Each direction holds at most 1 MiB that the reader has not consumed. A full direction returns
  `AGAIN`, and the writer's ring gets a writable event when the reader consumes. Ring records are at
  most 64 KiB.
- `shutdown` ends one direction after the bytes already written; the other direction still flows.
- After a full close the peer reads the bytes already delivered, then EOF. Its next write fails
  with `EPIPE`.
- Closing a listener keeps accepted streams. Peers it had not accepted read EOF. Linux reports
  `ECONNRESET` to those peers.
- One runtime allows 128 Unix listeners and 128 Unix connections, pathname and abstract together.
  A listener holds at most 64 connections it has not accepted; the next connect fails with
  `ECONNREFUSED`. Exhaustion fails with `ENOBUFS` and creates nothing. A connection counts until
  both ends close. At most 128 pathname requests may be waiting on the filesystem at once across the
  runtime; the next one fails with `ENOBUFS`. Abstract requests never wait on the filesystem.

## Errors

| Code           | When                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `EINVAL`       | NUL, unpaired surrogate, or a relative path                              |
| `EINVAL`       | abstract: `"\0"` alone, more than 108 UTF-8 bytes, unpaired surrogate    |
| `ENOENT`       | empty path, missing name or parent                                       |
| `ENAMETOOLONG` | more than 4096 UTF-8 bytes                                               |
| `ENOTDIR`      | a parent is not a directory                                              |
| `EACCES`       | no search on a parent, no write on the parent (bind) or socket (connect) |
| `ELOOP`        | symlink loop                                                             |
| `ENOTCAPABLE`  | no path scope, a scope that failed its check, or a path leaving it       |
| `EADDRINUSE`   | the name exists; abstract: a live listener holds it                      |
| `ECONNREFUSED` | not a socket, no live listener, another scope root, or a full backlog    |
| `ECONNREFUSED` | abstract: no live listener in this runtime, or a full backlog            |
| `ENOBUFS`      | runtime listener, connection or pending-request limit                    |
| `ECANCELED`    | the helper or runtime shut down during the call                          |
| `EBADF`        | the request reused a handle that already names a listener or socket      |
| `ENOTSUP`      | standalone host                                                          |

## Not supported

Datagram and seqpacket sockets, autobind (an empty abstract name), socket file descriptors passed between processes,
credentials (`SO_PEERCRED`), hard links to sockets, and any connection to a host socket.
