# Nonblocking WASI streams

A pipe bound through `WasiOptions.stdio` accepts Preview 1 `NONBLOCK`, bit 4, when
its descriptor has `FD_FDSTAT_SET_FLAGS`. `fd_fdstat_get` reports the shared flags.
`fd_read` on empty live input and `fd_write` on full live output return `AGAIN`,
positive WASI errno 6, without waiting. Errors leave the byte-count output unchanged.
Clearing `NONBLOCK` restores the endpoint's blocking `read` and `write` methods.
Short transfers, zero-length I/O, EOF and broken-pipe errors keep their usual meaning.

Duplicates and inherited pipe endpoints share the same flags, including across worker
transfer. Read and write ends have independent flags. Rights remain per descriptor;
setting flags does not add rights. In particular, this change does not grant
`FD_FDSTAT_SET_FLAGS` to pipes created by `runtime_proc.pipe`.

A host-supplied `Stream` opts in through mutable `fdflags` and immediate `tryRead`
and `tryWrite` methods. Its flag state belongs to the open description and must survive
`forProcess`, duplication and transfer. WASI never substitutes blocking I/O for a
missing immediate method. Default callback terminals do not provide shared flag state,
so enabling `NONBLOCK` returns `NOTSUP`, errno 58. Clearing zero flags succeeds.

Other known stream flags, such as `APPEND` or `SYNC`, return `NOTSUP`. Unknown flag
bits return `INVAL`, errno 28. Missing rights still return `NOTCAPABLE`, errno 76,
before flag validation. Regular-file flag behavior is unchanged.
