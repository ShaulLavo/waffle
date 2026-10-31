# Directory pages

`FileSystem.readdirPage(handle, cookie, byteLength)` returns Preview1 directory
records. WASI `fd_readdir` uses this method instead of requesting a complete list.
The existing `readdir` method still returns a full list for host callers.

## Bounds and records

A cookie is an unsigned 64-bit bigint. The byte limit is an integer from zero
through `0xffffffff`. Invalid arguments raise `FilesystemError` with errno 28.
The service checks these arguments and the session's handle before backend dispatch.

The result contains at most `byteLength` bytes, including a partial final header
or UTF-8 name. A caller resumes after the last complete record's cookie. A larger
buffer can complete a name longer than the service's initial response buffer.
The existing binary overflow transport carries larger results. An empty directory
page allocates no requested-size buffer, even when the byte limit is large.

## Cookies and mutations

Zero rewinds. Cookies 1 and 2 identify `.` and `..`. Every inserted directory
entry receives a later cookie. Cookies are opaque positions, not array offsets.
A cookie beyond the last live entry returns an empty result.

Enumeration observes the live namespace, not a snapshot. Deleted entries disappear.
A deleted cookie resumes at its live successor. A rename or replacement receives
a later cookie, so an entry can appear again after a rename. Renaming an entry
onto another name of the same inode remains a no-op. Exhausted cookie space raises
errno 61 before namespace edits, rather than wrapping or reusing cookies.

Each directory owns a balanced index of live entries and their encoded names.
Successor lookup takes O(log N + returned entries) work. Removed entries leave no
tombstones. No descriptor owns an iterator or a directory snapshot. Reconstruction
rebuilds the index without changing the persistence format. Cookies are not durable
positions across reloads.

## Permissions and lifetime

Page reads retain directory mode checks, descriptor rights, and revocation checks.
Dot entries report the directory and its stored parent metadata. A restricted
preopen still denies traversal above its namespace; parent metadata grants no access.
A removed but open directory keeps its existing dot-only view until close. Removing
its contents clears the live index. Closing or cancelling a request leaves no
page-specific retained iterator or response resource.
