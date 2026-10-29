# Committed filesystem watches

`FilesystemClient.watch(handle, options)` registers a watch on an authorized handle. It does not enable publication history or copy file contents. Both page operations and direct guest writes notify it.

```ts
const watcher = await client.watch(directory, { recursive: true, signal });
try {
  for (;;) {
    const batch = await watcher.next();
    if (batch.kind === "closed") break;
    if (batch.kind === "overflow") throw new Error("filesystem watch overflow");
    for (const event of batch.events) onChange(event.type, event.name, event.id);
  }
} finally {
  await watcher.close();
}
```

A synchronous guest cannot await `next()`. It reads the same subscriptions through the
`runtime_fs.watch_open`, `watch_read` and `watch_close` imports, whose packed records, delivery
guarantee and wake-up path are specified under
[guest filesystem watches](host-abi.md#guest-filesystem-watches).

Types are exported from `waffle/fs/watch` and `waffle/fs`. This is the transport for a Bun/Node adapter, not an implementation of Node's callback API. An adapter maps `change` and `rename`, retains its chosen display name for file watches, and reports overflow as an error rather than claiming a complete stream. Invoke guest callbacks after `next()` resolves. No callback runs under filesystem locks.

## Delivery and identity

- `read()` returns the currently queued batch. `next()` reads once and waits on an atomic notification when empty. Only one `next()` may wait per watcher. There is no timer, periodic tree scan, or idle pending service request.
- Events describe committed live state, not persistence flush completion. A write can become visible before its event is read. Multiple identical events can coalesce. Neither an exact operation count nor one event per syscall is promised.
- `change` covers content, size, mode, and timestamp changes. `rename` covers namespace entries, including create, remove, rename, replacement, symlink creation, and hard-link changes. Directory timestamps may also produce `change`.
- A directory watch reports relative names. It reports direct children by default, or descendants with `recursive: true`. Hard-linked files report every visible alias inside that directory. Moving a subtree updates future relative paths without rescanning it. Events buffered before a move keep their earlier relative names.
- The watch follows the root's stable 128-bit `id`, independent of path reuse. A file watch reports `name: null`. Unlink or replacement reports `rename` for the old identity; a retained old file can still report `change`. The new file at the same path is a different identity and does not rebind the watch. A moved directory watch follows its directory identity; a parent directory watch stops seeing descendants moved outside it.
- Symlinks are namespace entries, not traversal edges. Resolve the final symlink explicitly before registration to watch its target. A directory watch never follows symlinks into another tree.
- Registration requires a current client capability and read permission, plus search permission for a directory. Delivery rechecks the root's mode. Ancestor directories without read/search permission do not contribute relative names. Events do not expose aliases outside the watched root. Closing a descriptor does not rebind the identity. Registering an already detached node fails with errno 44.

## Registration and shutdown

The first subscription captures bounded namespace metadata under the same global lock used by direct writers. It snapshots the ring cursor and activates the subscriber count before releasing that lock. A direct writer cannot hold its file lock while waiting for capture: it acquires the global lock first. Writes committed before registration are part of the baseline; writes after activation append metadata before releasing their locks. Further registrations drain the shared ring before adding their subscription and reuse the graph.

`close()` is idempotent, wakes a pending `next()`, and releases the service subscription. An aborted signal has the same effect. Client disposal detaches abort listeners and closes local waiters. Service revocation wakes waiters with errno 11. Process reaping releases all subscriptions for its owner, including after forced worker termination. No guest response is needed for cleanup.

## Bounds and overflow

The ring reserves **147,472 bytes per shared filesystem root upfront**, including roots with no watches. A newly allocated default root grows by that amount. A connection that already reserves a larger fixed buffer uses that buffer's existing space. The graph and subscription queues are lazy JavaScript allocations, not included in that fixed figure.

The shared ring holds 128 metadata records. A service allows 128 subscriptions, each with at most 128 coalesced events. Its shared graph holds at most 4,096 identities and 16,384 namespace edges, including detached history while subscriptions remain open. Names must be losslessly representable in at most 1,024 UTF-8 bytes. Delivered relative paths are limited to 4,096 UTF-16 code units. No name or path is truncated.

A slow reader, an oversized or malformed name, graph/path expansion, or an exhausted safe-integer sequence yields an explicit terminal `overflow` batch with no partial event list. A full per-watch queue overflows only that watch. Lost ring or graph information overflows all subscriptions. A filesystem mutation still succeeds when its notification cannot fit. Registration over a namespace outside the bounds fails with errno 6 without enabling a watch.

After overflow, close all subscriptions, reconcile the consumer's view, and register again to capture a fresh metadata baseline. Capture happens only at registration. Sequence exhaustion at `Number.MAX_SAFE_INTEGER` is sticky and requires a new runtime root. Closing all watches stops ring appends and releases the graph. This bounded service is a notification facility, not a durable audit log.
