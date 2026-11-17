# Payload copies and ownership

This audit follows the source at `453ef5cd` and the Python streamed-download repair.
The counts below describe application buffers and logical byte lengths. They are
not browser heap measurements or performance claims.

| Boundary                         | Copies, aliases and lifetime                                                                                                                                                                                                                                        | Bound or admission                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program catalog and installer    | A catalog selection retains the original definition. Canonical and alias paths share one source function, download and compilation promise. Each path has a small regular marker file.                                                                              | Live filesystem metadata and registration must still admit every execution. Final symlink executable aliases are not granted by catalog aliases.                                                                                                                      |
| Runtime source to compiler       | Borrowed source receives one private snapshot before asynchronous compilation. The owned compiler entry takes that snapshot without another source copy. A successful loader replaces its source with the compiled module.                                          | The interrupt module cache retains 16 promises; registries retain their resolved modules. Instances and guest memory remain per launch. A count limit is not a byte budget.                                                                                           |
| URL and admitted-store downloads | The generic URL loader collects a response. Stored-module verification clones a response for streaming compilation and full-body digest verification.                                                                                                               | These are the separate download and admitted-cache hardening boundaries. This audit does not remove their copies or claim a body-size bound for them.                                                                                                                 |
| Python payload download          | Each file streams into one private buffer of its declared size. Transport views are copied into that buffer, never retained by their larger backing. Completed files wait for whole-payload verification, then become the installer's comparison bytes for cleanup. | Manifest identity and paths are checked before file fetches. Per-file counts and SHA-256 must match. The declared sum must be a safe integer. At most eight downloads run. Assembled buffers total at most the declared sum; Fetch and digest internals are excluded. |
| Python failure and retry         | The first terminal failure aborts owned fetches and prevents new file work. Readers join cancellation and release locks. Preparation joins the interpreter and payload work before rollback and retry.                                                              | Source and manifest callbacks have no abort parameter, so their work is joined. Failed filesystem cleanup remains reported and owned for a later cleanup attempt.                                                                                                     |
| Page write to VFS                | The filesystem client snapshots request bytes. Large requests have separately charged private input. The service copies accepted bytes into file pages. Reads return owned results.                                                                                 | Request admission, publication and dirty-capacity limits remain active. Two independent regular files have separate identities and mutable bytes even when their original content matches. Hardlinks intentionally share one identity.                                |
| Guest I/O                        | Guest filesystem identities borrow the page runtime. Direct reads copy file bytes into guest iovecs; writes use admitted operations and the existing publication path.                                                                                              | Revocation and filesystem quiescence precede physical worker retirement. No payload change bypasses those fences.                                                                                                                                                     |
| Workspace archive codec          | The internal parser copies each transport chunk and frame, verifies its digest before staging data, and awaits each sink operation. Source identities are provenance rather than new target identities.                                                             | Transport chunks are at most 65,573 bytes, metadata frames 16 KiB, and data frames 64 KiB. Frame lengths are checked before body allocation. Incompatible magic/manifest, corruption, truncation, budgets and cancellation prevent completion.                        |

The internal archive codec defaults to 1,000,000 entries and 1 TiB per file and in
total; callers can supply smaller budgets. The separate selected-archive planner
defaults to an 8 MiB archive, 256 entries, 128 files, 4 MiB per file and in total,
and 256 KiB of metadata. That planner is not wired to a production importer, so its
limits do not constrain ordinary VFS writes or the internal codec automatically.

## Metadata and importer boundary

Python borrows byte-identical existing files without replacing them, preserving
their existing metadata. New files use exclusive creation; collisions and caller
edits survive rollback. Python's manifest carries no mode, owner or mtime fields.
It cannot restore those fields from an archive.

Ordinary VFS content writes preserve the existing inode and supported mode while
advancing mtime. Waffle's file mode contract supports read/write bits, not executable
mode bits or Unix owner IDs. Archive metadata carries mode and mtime, but the internal
codec has no production VFS import sink. Directory metadata ordering and atomic durable
import are therefore obligations of a future importer, not established behavior here.
The public API does not expose an unfinished archive import operation.

## One binary fetch to guest path

`packages/curl/src/curl.ts` reads `Response.body` and awaits the selected output's
`write` for each chunk. `host-command.ts` passes only the explicitly granted file
callback, the original path, actual cwd and abort signal. A page owner may implement
that callback with `runtime.filesystem.writeFile`, as the curl runtime fixture does.
The filesystem client sends binary request bytes to the service, which writes file
pages. The Preview 1 guest then opens the file through its existing filesystem identity
and reads bytes into Wasm memory.

File output does not pass through stdout or a binary-to-text conversion. Awaited
writes provide backpressure. Cancellation or partial response failure aborts the
owned output and cancels/releases the response reader. The file owner defines what
happens to already committed partial bytes; the fixture preserves them. Neither a
successful command nor filesystem `drain()` establishes durability. Only explicit
`flush()` checkpoints data and metadata. Upload Blob snapshots are a separate replay
requirement, not lazy file staging authority.

## Regressions and limits

- `packages/python/tests/python-payload.unit.ts` covers stream counts, hashes,
  bounded views, peer cancellation, joined cleanup, primary errors, rollback and retry.
  Its 5-byte file refuses a 6-byte first chunk without pulling the remaining 4,096 bytes.
  Its failed download starts only the initial eight of twelve manifest files.
- `packages/python/tests/python-aliases.unit.ts` covers canonical and alias selection,
  original definition identity, deduplication and shared disposal.
- `packages/waffle/tests/runtime-facade.test.ts` counts one source snapshot and checks
  shared module identity and source release after successful compilation.
- `packages/waffle/tests/workspace-archive.test.ts` and
  `workspace-archive-pulls.test.ts` cover bounded framing, rejection before body pulls,
  backpressure, source closure, failed staging and cancellation without publication.
- `packages/curl/tests/runtime.test.ts` covers real command/stdio admission, granted
  VFS file callbacks, partial bytes, backpressure, signals and removal/disposal fences.

The manifest is the caller's payload policy. There is no independent ceiling on its
JSON, number of files or declared total, beyond representable byte counts. The separate
Python interpreter source still follows its source-loader contract. This audit does
not qualify native persistence, an archive importer, device execution or allocation
behavior inside Fetch, Web Crypto or the Wasm compiler.
