---
"@waffle-os/runtime": patch
---

Multi-tab `flush()` and descriptor `sync()` now enforce strict barrier ordering on both Host and Peer tabs: barriers wait for earlier in-flight writes (including cold file hydration, dirty-capacity retries, chunked uploads, and failover queues) and hold later Host or Peer writes behind active barriers. Cancelled cold writes and chunked uploads abort before committing and release staged Host upload buffers via settlement-tracked aborts, and `FilesystemService` retains descriptor `sync()` targets until the barrier settles so an immediate `release()` cannot invalidate a queued sync.
