---
"@waffle-os/runtime": patch
---

Opening a file reads its metadata once instead of twice. `FileSystem.permissions` takes the stat the caller just read, and the filesystem client answers from it instead of sending another stat request, which saves one filesystem round trip per `path_open` on a persistent multi-tab workspace.
