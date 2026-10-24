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
