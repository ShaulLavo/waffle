---
"@waffle-os/runtime": patch
---

A persistent workspace under load no longer fails filesystem calls with `ECANCELED` ("host lease expired") during a large write burst such as `bun install`. The Host's lease check no longer waits for the workspace's own IndexedDB checkpoint to finish, and a call whose lease lapses between two checks renews it instead of failing.
