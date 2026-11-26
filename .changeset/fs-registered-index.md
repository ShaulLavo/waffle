---
"@waffle-os/runtime": patch
---

Listing the registered files of a shared filesystem no longer walks the whole 32,767-slot identity table each time. Persistent checkpoints and clean-cache eviction use that list, and it now comes from a per-state index checked against the table's registered-slot count.
