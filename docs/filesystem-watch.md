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
- Registration requires a current client capability and read permission, plus search permission for a directory. Delivery rechecks the root's mode. Ancestor directories without read/search permission do not contribute relative names. Events do not expose aliases outside the watched root. Closing a descriptor does not rebind the identity. Registering an already detached node fails with errno 44, even when another subscription keeps its identity in the graph. A watch opened before unlink remains valid and follows the retained identity.

## Registration and shutdown

The first subscription captures live namespace metadata under the same global lock used by direct writers. Capture reads no file payloads. It snapshots the ring cursor and activates the subscriber count before releasing that lock. A direct writer cannot hold its file lock while waiting for capture: it acquires the global lock first. Further registrations share the index and allocate only their own subscription records.

Before a service namespace commit, the watch owner drains earlier direct-write records against the old index. It then applies the committed namespace effects in order and updates the live reverse edges before publishing wake-up progress. A queued write before a rename keeps its old name. Later writes use the new name. Moving an existing subtree changes its entry edges without rescanning the subtree. Removed, unpinned identities and names are collected at the end of the commit rather than retained as history.

`close()` is idempotent, wakes a pending `next()`, and releases the service subscription. An aborted signal has the same effect. Client disposal detaches abort listeners and closes local waiters. Service revocation wakes waiters with errno 11. Process reaping releases all subscriptions for its owner, including after forced worker termination. No guest response is needed for cleanup.

## Bounds and overflow

The ring reserves **147,472 bytes per shared filesystem root upfront**, including roots with no watches. A newly allocated default root grows by that amount. A connection that already reserves a larger fixed buffer uses that buffer's existing space. The graph and subscription queues are lazy JavaScript allocations, not included in that fixed figure.

The shared ring holds 128 metadata records. Each watch holds at most 128 coalesced events. The subscription count and live namespace are admitted by their allocated bytes, not separate 128-watch, 4,096-identity, or 16,384-edge limits. Names must be losslessly representable in at most 1,024 UTF-8 bytes. Delivered relative paths remain limited to 4,096 UTF-16 code units. No name or path is truncated.

Every ordinary memory or persistent backend has one lazy root watch account. Backend wrappers borrow that same account. Its source defaults are:

- 64 MiB of aggregate backing, including reusable slabs, padding, and overlapping allocations during growth or rehash.
- 16 MiB for pending-event arenas, within that aggregate allocation.
- 1 MiB for capture and routing work, also within the aggregate allocation.
- 4,194,304 declared control units, separate from exact backing bytes.
- 4 KiB allocation slabs.

The account covers backend-service allocations, not guest heaps, encoded records already returned to a guest, or the existing request transport buffers. Those keep their separate ownership and limits. Control units are declared allowances for bounded JavaScript bookkeeping and decoded batches. They are not a measured 4 MiB JavaScript heap limit. Native allocator overhead and garbage-collector or JIT observations are not hard heap bounds. A genuine startup `MemoryBudget` additionally admits backing and the declared control allowance. Ordinary roots without that optional parent still enforce their own watch account.

These defaults were selected against a measured post-install namespace with 18,377 identities, 18,376 edges, and 260,524 UTF-8 name bytes. A component control matching those totals admitted 18,315 potential file/directory subscriptions. A doubled control admitted 36,630 registrations with pending events and a full scratch reservation at 32,784,384 bytes of retained backing. Its per-entry names and topology were synthetic, not the exact application tree. These controls neither identify a historical application failure's first exhausted bound nor prove application startup.

The internal resource report distinguishes exact retained backing, active arena spans, staged allocations, completely reusable slabs, and padding. The event-byte counter charges allocated queue-arena capacity, including free slots while other watches remain open; it is not a count of pending event payloads. The queue report counts pending records separately. An empty queue may retain bounded reusable event capacity until the last watch closes. The live index and queue reports separately count occupied records and names. Closing a watch or consuming its batch returns reusable slots and name storage. Closing the last watch releases the live index and stops ring appends. Slabs remain charged and reusable at the root's bounded high-water mark until root disposal. A pending, unconsumed response retains its batch credit until consumption, cancellation, or owner cleanup. Cancellation before publication restores the batch or reports terminal overflow if it cannot be restored completely.

A slow reader, an oversized or malformed name, path expansion, exhausted allocation/work credit, or an exhausted safe-integer sequence yields an explicit terminal `overflow` batch with no partial event list. A full queue or refused event allocation overflows that watch. Lost ring information or failed common-index/routing work overflows all subscriptions. The bounded incomplete index remains only to close its existing subscriptions; it stops accepting namespace updates. A filesystem mutation still succeeds when its notification cannot fit. Failed registration returns errno 6 without enabling a partial watch. Cancellation or owner revocation rolls back staged allocation and subscription ownership.

After overflow, close all subscriptions, reconcile the consumer's view, and register again to capture a fresh baseline. Sequence exhaustion at `Number.MAX_SAFE_INTEGER` is sticky and requires a new runtime root. Capture costs O(N + E + name bytes), with expected constant-time indexed registration afterward, apart from draining pending records and routing matching events. Hash probes and routing work remain bounded by admitted storage and work credit. This service is a notification facility, not a durable audit log.
