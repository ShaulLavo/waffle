---
"@waffle-os/runtime": patch
---

Guests can ask for a canonical path in one filesystem request with the new `runtime_fs.path_realpath` import, instead of one `path_readlink` per path component.
