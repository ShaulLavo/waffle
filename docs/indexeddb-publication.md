# Selected publication records

The normal IndexedDB adapter stores an optional settled publication checkpoint in
its selected snapshot or journal. It uses the existing epoch-checked strict
transaction for payloads, namespace, generation and publication. There is no
separate receipt store or latest-record lookup.

Change bytes become JSON byte arrays before checksumming. Recovery bounds those
arrays using the validated publication limits, rejects non-integer or out-of-range
bytes, and calls `snapshotPublicationCheckpoint` to validate and own the decoded
record. It preserves `contentVersions` and the exact reserved `sessionSerial`
frontier. The adapter does not allocate sessions or choose reservation policy.

A metadata-only batch can select a publication without new payloads or inode
changes. Selecting a batch without publication clears the previous record in
memory, journal replay and compacted snapshots. `load()` returns owned copies.

Recovery keeps the existing newest-complete-chain policy. If a snapshot or
journal has an invalid publication, the whole candidate is invalid. An older
valid chain may be selected, but its record must accompany its own namespace and
payload references. With no valid chain, loading fails without a repair write.
This normal adapter port adds no staged format or required-head recovery policy.

## Verification

Run the focused replay tests with:

```sh
bun test tests/indexeddb-publication.test.ts
```

Run the dedicated native controls through the execution host's canonical browser
queue with its installed Playwright engines:

```sh
bun tests/indexeddb-publication.test.ts --native chromium firefox webkit
```

The native controls cover snapshot and journal byte ownership, metadata-only
saves, compaction, untracked clearing, exact abort cause and rollback, epoch
fencing, corrupt-record selection, and real worker termination after commit but
before reply delivery. The runner owns browser/server cleanup, and each control
owns its database, connections, temporary hooks and workers.

This is a frozen-base adapter handoff for continuity integration. It does not add
resident capture/restore, durable startup reservation, an import producer, or
supported SAFE mode. Those remain separate work.
