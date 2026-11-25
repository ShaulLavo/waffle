---
"@waffle-os/runtime": patch
---

Add `startCommand` options to run cooperative compiled guest modules, such as Bun, with `programs: "guest"` and to stop the remaining process tree when the first process exits with `onLeaderExit: "stop"`. Both options preserve the existing behavior by default.
