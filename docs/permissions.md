# Inode mode and effective access

Waffle uses one virtual filesystem principal. All clients and processes act as that principal. Connection owner IDs are lock and lifetime identities, not users. Inodes belong to the virtual principal. Numeric ownership, groups, setuid/setgid and symlinks are unsupported.

New files have mode `0600`; new directories have mode `0700`. Files support owner read/write bits, mask `0600`. Directories support owner read/write/search and sticky, mask `01700`. Waffle stores the directory sticky bit. Because the sole caller owns every directory and entry, that caller may remove its own entries in sticky directories. This does not implement multiple-user sticky-directory policy. No directory path receives a special mode based on its name, including `/tmp` and `/bin`.

`MemFS.setMode(handle, mode)` and the worker client's `setMode` operation change real inode policy. Invalid integers return `EINVAL`, errno 28. Unsupported bits return `ENOTSUP`, errno 58, without changing the inode. These are trusted host policy operations, not a guest chmod import. They are independent of descriptor rights; granting an inode permission never restores stripped descriptor rights.

## Query

`FileSystem.permissions(handle)` returns `{ mode, modeSupported, access, accessSupported }`. An adapter without this operation or without authoritative mode returns unsupported. Values outside a supported mask carry no information. A supported clear bit means denied, not unknown. Access uses read `4`, write `2` and search-or-execute `1`. Directories support all three; files support read/write only. Regular-file execution is unsupported here; executable admission belongs to the separate program registry. Neither result may substitute for the other.

Directory reads list names. Directory writes modify entries and require both write and search for actual mutations. Path resolution checks each traversed directory's search bit, including dot segments. Querying a directory's own metadata requires search on its ancestors, not read or search on that final directory. Missing paths and denied traversal remain different errors.

The built-in `runtime_fs.path_permissions_get` guest import uses the caller's WASI directory descriptor and `PATH_FILESTAT_GET` right. See [the host ABI](host-abi.md#inode-permission-query) for its four-word record. Querying metadata does not open or hydrate payloads. Preview1 filestat stays exactly 64 bytes.

## Live changes and bytes already returned

Reads, writes, append, resize, directory listing and namespace mutations enforce current inode policy. Direct worker I/O rechecks shared mode under the same file lock that protects data and slot identity. A chmod completed before a later operation denies that operation even if the worker cached its direct-I/O slot. Retained or transferred handles do not freeze permission grants. Ordinary descriptor rights can deny an operation independently with `ENOTCAPABLE`, errno 76. Inode denial is `EACCES`, errno 2.

A mode change does not erase bytes already returned. Caller-owned read buffers and any previously exposed host byte views remain accessible to that caller. Waffle does not claim memory isolation from trusted JavaScript that owns filesystem objects or shared buffers. Enforcement applies to subsequent filesystem API operations, not retroactive revocation of memory.

## Saved metadata adoption

Modes persist with inode metadata through overwrite, hard links, rename, retained unlinked handles and reload. The inode moved by a replacement rename keeps its own mode; an open replaced inode keeps its previous mode until its last reference closes.

Saved entries without mode are an explicit metadata-adoption case. They receive the actual new enforced defaults, files `0600` and directories `0700`. The next checkpoint writes those values without reading or replacing payloads. Existing format identities and format version 1 remain unchanged. This is saved-data adoption, not a runtime version-skew fallback. Invalid or unsupported stored mode bits are rejected by storage validation.
