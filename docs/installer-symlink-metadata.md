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
