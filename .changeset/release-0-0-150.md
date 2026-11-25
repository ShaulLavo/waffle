---
"@waffle-os/runtime": patch
---

Support regular-file reads, writes, appends, and worker error diagnostics on `MultiTabBackend` when direct shared-memory file I/O is disabled, keeping shared file offsets atomic across signals, cancellation, and host failover. Also prevent unrelated filesystem wakeups from delaying or outliving `poll` deadlines, fix multi-buffer reads with empty leading iovecs, and expand file-descriptor conformance coverage across all storage backends.
