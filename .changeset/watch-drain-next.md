---
"@waffle-os/runtime": patch
---

Add bounded batched `watchDrain` and `runtime_fs.watch_next` with O(1) watch readiness tracking so guests with many open watches drain only ready subscriptions without per-watch polling round trips.
