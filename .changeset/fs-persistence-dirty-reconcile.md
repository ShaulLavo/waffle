---
"@waffle-os/runtime": patch
---

`PersistentBackend` now reconciles dirty-admission debt after a commit even when concurrent writes arrived while storage was persisting, maintains namespace metadata bytes incrementally in O(1), and skips idle background checkpoint ticks when nothing changed. Cold package installs no longer accumulate stale dirty debt across completed checkpoints and stall in `waitForDirtyCapacity`.
