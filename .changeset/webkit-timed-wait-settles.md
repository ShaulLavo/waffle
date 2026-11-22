---
"@waffle-os/runtime": patch
---

Keep thread, terminal and GPU waits and filesystem teardown moving on WebKit, which can lose the wake for an `Atomics.waitAsync`.
