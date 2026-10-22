# Immutable OPFS payload ranges

`OpfsStorage.readRange(key, { offset, length, signal? })` returns an owned
`Uint8Array` for an existing immutable storage key. It reads native sync-access
handles at physical offsets. It does not call `read(key)` or hydrate the whole
payload before slicing. `read(key)` still returns the complete payload.

## Range contract

- `offset` and `length` are nonnegative safe integers. Their sum must also be a
  safe integer. Invalid arguments reject with `RangeError` before admission.
- The key must exist in the adapter's retained snapshot metadata. An unknown key
  rejects, including for a zero-length request.
- A request crossing EOF returns only the remaining bytes. At or beyond EOF it
  returns an empty array. A zero-length request returns an empty array.
- The native payload size must match the retained metadata, even for an empty
  result. A mismatch rejects before allocating a payload buffer.
- The adapter allocates one payload buffer of
  `min(length, max(0, retainedSize - offset))` bytes. Native read targets are views
  of that same allocation.
- A progressing short native read continues at the next physical offset. Zero,
  negative, fractional, nonfinite, or oversized native progress rejects with
  `EIO`, never partial success. Native errors use the existing OPFS translation
  and retain their cause.

## Cancellation and ownership

The method snapshots its options before queueing. It checks cancellation before
admission, when dequeued, after initialization and file lookup, after handle
acquisition, between native reads, and before returning. Cancellation rejects with
`signal.reason`, including non-Error reasons. A queued cancelled operation starts
no payload acquisition.

An already-started native sync-handle acquisition cannot be cancelled. The adapter
joins it and registers the exact returned handle before rejecting an aborted
range. The normal bounded cache retains that handle until eviction or close.
`close()` waits behind admitted operations, including an aborted pending
acquisition. Cancellation does not release the workspace lock or skip cleanup.
Synchronous native reads cannot be interrupted halfway through one native call.
Retry backoff checks cancellation before the next attempt; cancellation does not
start another native acquisition.

Ranges use the existing cache, handle limit, eviction, one-shot close outcome,
and failed-close ownership. A failed original close still retains that original
handle and the workspace lock. Cancellation does not retry the close or turn the
failed outcome into success.

## Proof and limits

`bun test tests/opfs-range.test.ts tests/opfs-close.test.ts` covers bounded buffers,
EOF, invalid arguments, progressing and invalid short reads, native error causes,
queued and in-acquisition cancellation, late-handle close, failed eviction,
failed-close reason identity, retained snapshot keys, and cache eviction. These
unit controls use explicit directory, handle, and lock stand-ins.

`bun tests/opfs-range-browser-runner.ts` runs one dedicated-worker Chromium cell
through `BrowserRunnerLifecycle`. It seeds a native 128 MiB OPFS file with
`truncate` and writes the measured ranges, without a whole-file seed allocation.
The cold payload read records 4,096 native bytes at offset 65,539, one native read,
one 4,096-byte `Uint8Array` allocation, and a 4,096-byte native target buffer. It
checks clipped EOF bytes and observes the exact original native handle closing
once. The runner observes original worker closure and removes its browser
scratch. This is ordinary successful close evidence, not qualification of a
spontaneous failed native close or the held close-controller campaign.

Storage keys name immutable payload revisions retained by this adapter. They are
not public stable file IDs, durable history identities, or retained-version leases.
No public root range API, `StorageBackend` interface change, IndexedDB chunked
physical reads, format migration, or above-RAM whole-engine certification is
included. The persistent root still hydrates full payloads through its existing
`read(key)` contract.
