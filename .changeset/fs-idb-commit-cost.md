---
"@waffle-os/runtime": patch
---

`IndexedDBStorage` now tracks recovery payload roots in O(1) via `PayloadSizes` instead of rescanning the entire tree, both bases, and every journal on every commit, runs payload chunk SHA-256 digests with bounded concurrency without copying owned single-chunk buffers a third time, clones persistence batches directly instead of calling `structuredClone` over `upserts`, and writes new payload keys directly after the epoch check without per-key `data.get` lookups.
