---
"@waffle-os/runtime": patch
---

The first read of a file from a saved IndexedDB workspace takes one transaction instead of one for the manifest plus one per 64 KiB chunk, and looking up a stored file's size no longer scans the whole file tree. Every chunk is still checked against its stored SHA-256 checksum before any byte is returned.
