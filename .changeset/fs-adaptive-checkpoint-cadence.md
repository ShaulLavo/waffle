---
"@waffle-os/runtime": patch
---

`PersistentBackend` adapts its background checkpoint cadence during sustained write bursts, keeping the 50 ms cadence for quiet edits while batching continuous bursts up to 500 ms (or flushing early once 512 dirty nodes or 8 MiB of resident bytes accumulate, or as soon as writes pause). Explicit `flush()`, `fsync()`, and `close()` still persist immediately.
