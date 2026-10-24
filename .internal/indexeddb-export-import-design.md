# IndexedDB chunks: logical export and import design

Split from `docs/indexeddb-chunks.md`. Describes design that is not implemented.

Export and import are specified here, not implemented. A future exporter pins one
committed generation, streams logical inode metadata and directory entries, then
bounded byte segments per immutable revision with lengths and checksums. A final
manifest includes filesystem identity, logical schema, generation and an archive
integrity digest. Physical IndexedDB keys and chunk packing are not the archive API.
A stalled or cancelled exporter releases pins and its bounded queue.

A future importer validates the logical schema, inode graph, names, lengths and
segment checksums while writing into an isolated staging namespace. It enforces
byte and metadata budgets, reports quota errors, and publishes one complete root
only after final integrity validation. Cancellation and interruption discard the
staging namespace without changing the old root. Adapter switching is explicit.
