# Page symbolic-link metadata

`SharedFilesystem.resolvePath` returns the canonical path reached by the live tree
walk. Intermediate links expand before later components, including `..`. The result
is not the lexical normalization of the input.

`resolvePath` and `lookup` do not follow an ordinary final link. Its metadata has
`kind: "symlink"` and a required `target` containing the raw link text. A dangling
final link still has metadata. `readFile` follows the final link. Trailing-slash
behavior remains the existing walker policy; no-follow mutation semantics for a
trailing slash are a separate, unresolved boundary.

A directory returned by `lookup` has a `children` map of shallow `EntryMetadata`.
Child directories have no populated `children` map. Files and links have no such
map either. The `kind` discriminant identifies which fields exist.

`listFiles` follows links in the starting path, including its final component, then
lists regular files below that actual node. Returned paths use that node's canonical
path. Recursive enumeration skips symbolic-link children. It does not recursively
follow every link in the tree.

The process registry snapshots the exact normalized registration before waiting for
metadata. It rejects non-file metadata and a canonical path different from that key.
This correction does not change registration or admission. Final linked executable
aliases are not supported by this metadata API. Broader linked-executable policy
needs a separate design, grant, and validation.

`MemFS.lookup` returns `undefined` for a missing path. Traversal failures, including a
non-directory component, a link loop, or a search-permission denial, throw
`FilesystemError` rather than masquerading as missing metadata. Page `readFile` and
persistent preparation can propagate those errors. This is an intentional distinction
between absence and an invalid or denied walk, not a claim of complete POSIX behavior.

Native IndexedDB and OPFS durability, archive export, the real Bun page, and consumer
delivery are not accepted by the metadata checks. Archive export must refuse a link
before charging or pinning it; that integration belongs to the export owner.

## D1 and D2 final components

No-follow resolution rejects a final symbolic link followed only by separators with
errno 54. This supersedes the unresolved trailing-slash policy described above.
Bare link metadata and readlink still return the link and its raw target. Explicit
final-follow resolution can reach a directory link with trailing separators.
A suffix containing `.` or `..` makes the link intermediate and uses actual parents.
Page removal selects the actual no-follow edge, keeps missing paths false, and does
not remove root or terminal-dot paths. Both rename operands resolve before effects.

In a descriptor-alias candidate walk, only real symbolic links obey the caller's
final-link policy. Without trailing separators, exclusive creation returns20 and
other no-follow opens return32. A no-follow final link with separators returns54
first. Explicit follow retains the same 40-expansion budget. Virtual descriptor
aliases retain their existing reopening, rights, identity, flags and offset rules.
The ordinary `path_open` preliminary no-follow resolve is unchanged; this section
does not grant a broader rewrite of that open path or linked executable admission.

Directory-creation provenance, readlink pointer and lifetime guarantees, native
storage, archive refusal and consumer delivery remain separately gated.

## Ordinary path_open explicit follow

For a nonexclusive ordinary open, `path_open` applies the requested final-follow
flag on its first resolution. A directory link with trailing separators can open
when follow is explicit. Exclusive creation keeps no-follow resolution first,
including errno 20 for a bare existing link and errno 54 for its trailing separators.
This replaces the preliminary no-follow limitation stated in the D1/D2 section.
The redundant second resolution is removed. Other no-follow operations, alias
selection, creation policy, rights and output ordering remain unchanged.

## D3 explicit directory creation

Page `mkdirp`, configured preopen, and `writeFile` may create missing directories
named by the input path. They may traverse symbolic links to existing directories
and create an explicit suffix there. They refuse missing directory components
introduced by a link target with errno 44, including a missing final directory
target of `mkdirp`. Nested target suffixes retain that origin. Planning refusal
attaches no pending nodes and leaves existing bytes, identities, mtimes, and link
accounting unchanged. Existing non-directory traversal still returns 54.

Nonexclusive `writeFile` may create a missing final file referent under an existing,
authorized actual parent. It cannot create that referent's missing parent chain.
Exclusive creation still refuses an existing final link with errno 20. The service's
existing missing-parent guard remains narrower than direct MemFS for input paths
that traverse a missing component before `.` or `..`. WASI mkdir remains
nonrecursive. Actual-parent traversal, root confinement, rights, and each walk's
single 40-expansion budget remain unchanged.

The focused creation tests use real MemFS planning, service transport, an ordinary
Wasm guest, and the page API with a memory worker under Bun. These checks do not
qualify native storage, browser execution, Bun installer delivery, readlink memory
or lifetime guarantees, or export-owned archive refusal.

## D4 readlink memory and error policy

Preview1 readlink normalizes its five memory fields as wasm32 unsigned values.
It checks the complete input, capacity, and four-byte count spans before filesystem
work. Invalid spans return EFAULT21 before descriptor and path errors, without
output. With valid spans, existing descriptor, rights, final-separator, missing,
and wrong-kind errors retain their meanings.

Readlink copies a raw UTF-8 byte prefix without a NUL and reports the copied count.
A short buffer may end inside a multibyte character. Valid zero capacity reports
zero. Both output views come from current memory after filesystem work. Direct
encoding avoids a target-sized staging buffer. A partial final character needs at
most two UTF-16 units of scratch encoding. Backend strings and transport responses
are not included in that local staging bound.

A resolved service handle is still a transient capability, not a multi-call lease.
Explicit retain/release protects an inode through rename and unlink. An idle
unretained detached capability may be revoked. D4 does not add atomic ownership
between resolve and readlink. The stronger N5 borrowed-result lease remains a
separate shipping requirement. Errors are not retried by resolving another inode.

## Direct resolve completion ownership

An ordinary `FilesystemService` resolve completion owns one reference to each
unique defined parent and node before trimming or publishing the result. Inline
results retain those references without storing payload bytes. An overflow
result keeps them after its last payload transfer. Discard, cancellation, failed
acquisition, and session disposal release the completion's ownership. These
references use the existing capability counts and backend pins, independently
of explicit retain RPC ownership. No new authority or capability limit is added.

`FilesystemClient.resolveBorrowed(directory, path, followFinal)` performs an
uncached direct resolve. It adopts each unique defined identity while the
completion still owns it, then discards the completion. It returns either a
positive errno or `{ path, release }`. `path` is a readonly snapshot. `release()`
is idempotent and drops only the borrow's acquired references. Partial adoption
rolls back before completion disposal. A retained identity survives ordinary
rename, unlink, and name replacement, but never session revocation.

Existing `resolve()` remains transient, including its cache. Decoding a raw
completion alone does not adopt its identities. Retain them before releasing the
completion if they must survive later namespace changes.

This contract covers the direct service and client only. A resident connection
returns unsupported-operation58 from `resolveBorrowed` before submission.
Resident forwarding, the required `FileSystem` interface, MemFS borrows, and WASI
borrow integration remain separate work. Backend implementations must preserve
their own result until returning it. This direct unit does not establish a lease
inside arbitrary asynchronous backends, native storage, or Bun consumers.
