# Inode mode and effective access

Waffle uses one virtual filesystem principal. All clients and processes act as that principal. Connection owner IDs are lock and lifetime identities, not users. Inodes belong to the virtual principal. Numeric ownership, groups, and setuid/setgid are unsupported.

New files start with mode `0600`, and new directories start with mode `0700`. Regular files support mask `0777`, covering owner, group, and other read, write, and execute bits. Directories support mask `01777`, covering those nine bits plus the sticky bit `01000`. Symlinks and sockets support mask `0600`. Owner bits determine effective access for the sole virtual principal. Waffle stores and reports group, other, and regular-file execute bits. Because the sole caller owns every directory and entry, that caller may remove its own entries in sticky directories.

`MemFS.setMode(handle, mode)` and `FilesystemClient.setMode(handle, mode)` change the inode mode and update `ctime`. Host calls with a non-integer or a value outside `0..0xffffffff` return `EINVAL`, errno 28. Bits outside the inode's supported mask return `ENOTSUP`, errno 58. Guests running under the browser Waffle WASI adapter change regular-file and directory modes through `runtime_fs.path_filestat_set_mode` and `runtime_fs.fd_filestat_set_mode`. Each import requires its own descriptor right. See [inode mode mutation](host-abi.md#inode-mode-mutation).

## Query

`FileSystem.permissions(handle)` returns `{ mode, modeSupported, access, accessSupported }`. An adapter without authoritative mode returns `undefined`. In `access`, a clear bit within `accessSupported` means access is denied. Access uses read `4`, write `2`, and search `1`. Directories report `accessSupported` as `7`, covering read, write, and search. Regular files report `accessSupported` as `6`, covering read and write. Stored file execute bits appear in `mode`, and the separate program registry governs executable admission.

Directory reads list names. Directory writes modify entries and require both write and search for actual mutations. Path resolution checks each traversed directory's search bit, including dot segments. Querying a directory's own metadata requires search on its ancestors, not read or search on that final directory. Missing paths and denied traversal remain different errors.

The built-in `runtime_fs.path_permissions_get` guest import uses the caller's WASI directory descriptor and `PATH_FILESTAT_GET` right. See [the host ABI](host-abi.md#inode-permission-query) for its four-word record. Querying metadata does not open or hydrate payloads. Preview1 filestat stays exactly 64 bytes.

## Live changes and bytes already returned

Reads, writes, append, resize, directory listing and namespace mutations enforce current inode policy. Direct worker I/O rechecks shared mode under the same file lock that protects data and slot identity. A chmod completed before a later operation denies that operation even if the worker cached its direct-I/O slot. Retained or transferred handles do not freeze permission grants. Ordinary descriptor rights can deny an operation independently with `ENOTCAPABLE`, errno 76. Inode denial is `EACCES`, errno 2.

A mode change does not erase bytes already returned. Caller-owned read buffers and any previously exposed host byte views remain accessible to that caller. Waffle does not claim memory isolation from trusted JavaScript that owns filesystem objects or shared buffers. Enforcement applies to subsequent filesystem API operations, not retroactive revocation of memory.

## Descriptor paths and reopening

The WASI layer, not MemFS, resolves `/dev/fd/N`, `/proc/self/fd/N` and the three
`/dev/std*` aliases against the current process. Relative equivalents work through the
root preopen. Missing descriptors are `ENOENT`; shared filesystem clients do not see
process-specific namespace entries. Opened root directories also recognize normalized
aliases; other directory bindings use ordinary resolution. Search permission on the root
and existing real ancestor directories is checked before opening a virtual alias.

A regular-file reopen checks the inode's current read and write policy and bounds requested
rights by the live root preopen's inheriting rights. Reopening an alias through `path_open`
keeps requested mode-mutation rights that the source holds in its corresponding base or
inheriting mask. Explicit `runtime_proc.fd_reopen` returns `ENOTCAPABLE`, errno 76, when the
source lacks a requested mode right. Both paths retain the inode across unlink and give the
reopened descriptor a separate offset and flags. Pipes, terminals, and directories share
their existing description and may only narrow its rights. See [the reopen ABI](host-abi.md#reopen-an-existing-descriptor)
for flag, error and redirection semantics.

## Saved metadata adoption

Modes persist with inode metadata through overwrite, hard links, rename, retained unlinked handles and reload. The inode moved by a replacement rename keeps its own mode; an open replaced inode keeps its previous mode until its last reference closes.

Saved entries without a stored mode adopt `0600` for files and `0700` for directories. The next checkpoint writes those values without reading or replacing payloads. Storage validation preserves saved modes within each entry kind's supported mask, `0777` for files, `01777` for directories, and `0600` for symlinks and sockets.
