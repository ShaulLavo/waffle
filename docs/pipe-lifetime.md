# Pipe lifetime and costs

This page describes an experimental implementation, not an accepted consumer release.
The measured throughput regression blocks release.

A parent can keep a pipe open while sequential children inherit and release its descriptors.
The pipe reuses drained participant rings instead of reserving one permanent ring for every
historical process. The default writer and reader limits remain 16 each.

## Opaque endpoint ownership

`PipeEndpoint.handle()` returns an opaque structured-cloneable capability. A host may store,
forward, or clone it and call `attachPipeEndpoint`. Attachment refers to the same reference;
it does not retain another reference. Closing either attached wrapper closes that reference.
`PipeController.duplicate(endpoint)` retains a separate reference for the same process.
`endpoint.forProcess(pid)` retains the child's process participation before descriptor
inheritance returns. Its same-process case returns the original endpoint.

Handles expose only identity, process, and direction in their supported type. Their wire data
is private transport state. Reading or mutating raw shared buffers, cursor views, lifetime
words, or physical slots is unsupported. In particular, a raw view retained after revocation
has no non-aliasing guarantee. There is no old-format or version-skew adapter.

Closed or revoked endpoint reads and writes return `-PipeErrno.BADF`. A stale endpoint cannot
retain or duplicate a replacement participant. Inherited and duplicated references share the
same open description's mutable `fdflags`, including after Worker attachment. A pipe's read
and write descriptions are independent.

## Reuse without guest-held locks

A ring's membership word combines its incarnation with its reference count or unpublished
reservation. Reservations cannot be stolen. Close and revoke compare the captured incarnation
when they change membership. A new participant initializes payload words, record metadata,
and cursors with a new incarnation before publication.

Payload words contain four bytes and an incarnation tag. Writes change a word with an atomic
comparison. Reads validate tags and advance a tagged consumption cursor before copying bytes
to the caller. A supported operation paused before its atomic mutation cannot change a later
incarnation. A check before an untagged byte copy would not provide this property.
No terminated Worker can strand a guest-held pipe lock because the protocol has no such lock.

Closed writers retain queued records until readers drain them. Records preserve write order,
and writes of at most `min(4096, capacity)` bytes stay contiguous across short reads. A full
record table or payload ring applies backpressure. No free concurrent slot returns
`PipeErrno.NFILE`, including when closed participants still own undrained bytes. That failure
does not revoke existing writers or discard their records.

## Reader inheritance and cancellation

The first reader can consume source rings directly. A different reader incarnation switches
the pipe permanently to the supervisor relay, even if it reuses the first reader's PID.
The relay captures destination and delivery incarnations. A delayed relay write, read, or
demand clear cannot act on a replacement reader.

An empty read requests delivery. Readiness alone does not reserve bytes. The relay recovers
unread deliveries after cancellation and keeps their unread tail ahead of later records.
EOF waits for all writers, including unpublished inherited reservations, and queued bytes.
Reap or cancellation revokes supported operations and wakes blocked readers. Filesystem
quiescence still precedes physical Worker termination; pipe reuse does not change that rule.

## Retained memory and finite bounds

For payload capacity `C`, each participant ring allocates:

```text
records = min(C, 1024, 2^(30 - log2(C)))
ring bytes = 56 + 2*C + 24*records
pipe bytes = 48 + (maxWriters + maxReaders)*ring bytes
```

At the defaults, `C` is 65,536 and each ring has 1,024 records. The pipe allocates exactly
4,982,576 bytes. The previous representation allocated 2,622,760 bytes, so the increase is
2,359,816 bytes, about 90%. The initial allocation is larger; it does not grow with sequential
children. A real supervisor fixture measured the same 4,982,576 bytes after 16, 100, and 3,001
children and their consuming waits. The parent retained one reader and one writer throughout.
No historical banks remain allocated. Disposal invalidates endpoints; JavaScript garbage
collection releases the pipe buffer once all host references disappear.

These counts exclude JavaScript objects, temporary I/O copies, the service wake word, and
small shared reference state. Each retained reference has a 4-byte lifetime allocation.
Each independently opened description has a 4-byte flags allocation. Inheritance and duplication
share flags. Retaining stale handles keeps their host objects and reference allocations alive;
the pipe does not keep a growing list of those handles.

The service-wide registry is separate from each pipe. Defaults initially commit 2,105,360 bytes
and reserve a maximum of 268,443,664 bytes. It supports 1,024 simultaneously enrolled processes
and up to 16,777,216 concurrent cursor allocations, at 16 bytes each. Cells reuse tagged
allocations. Collection does not release a live ring's mapping, even after its owner row is
collected. The ring must recycle or its controller must be disposed. An unannounced abandoned
pipe can therefore retain cells until its controller is attached and retired. A small registry
fixture used at most six cells through 3,001 children and had zero active cells after disposal.

Ring incarnations and individual registry-cell tags have 31-bit bounds. The pipe rejects new
incarnations before wrap, after at most 2,147,483,647 reservations. Registry cells retire before
their tag wraps. These are finite lifetime identity limits, distinct from concurrent slot and
cell limits. No claim of unlimited lifetime is made.

At the largest configured 16 MiB payload capacity, the record table has 64 entries rather than
1,024. Small writes can fill record capacity before payload capacity. Default capacities and
record counts are unchanged.

## Measured throughput cost

A narrow Bun 1.4.4 probe on the same Linux host compared accepted source with this representation.
It transferred 1 MiB in 4 KiB write/read pairs, after a 64 KiB warmup, for three samples.
The accepted implementation's median was 2.402 ms, about 416 MiB/s. The tagged implementation's
median was 423.827 ms, about 2.36 MiB/s, roughly 176 times slower in this fixture.

Per-byte tagged atomic payload access is expensive. This is not a browser or application
benchmark, and it is not a performance acceptance claim. The fixed-memory safety result does
not establish acceptable throughput for consumers.

The focused regression sources are `tests/pipe-persistent-lifetime.test.ts`,
`tests/pipe-opaque-lifetime.test.ts`, and `tests/pipe-opaque-browser.ts`. The browser proof covers
a pre-cloned blocked Worker, cancellation, slot reuse, and a physically delayed old mutation.
Those tests do not promise safety for raw shared-buffer mutation.
