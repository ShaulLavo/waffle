---
"@waffle-os/runtime": patch
---

Add multi-tab shared persistent filesystem support via `whenBusy: "attach"`. Multiple same-origin tabs can attach to, read, write, and watch the same live IndexedDB or OPFS workspace with automatic host election, failover, and cross-tab `fs.watch` propagation.
