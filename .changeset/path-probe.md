---
"@waffle-os/runtime": patch
---

Guests can check a list of candidate paths in one filesystem request with the new `runtime_fs.path_probe` import, which returns the first one that names a regular file or a directory. Module resolvers use it instead of one stat round trip per candidate.
