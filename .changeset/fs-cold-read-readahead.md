---
"@waffle-os/runtime": patch
---

`PersistentBackend` now detects sequential cold descriptor scans and fetches a page-aligned 1 MiB readahead window (bounded to half the cold-read cache budget and clamped to EOF) into `ColdReadCache` in one storage read, reducing storage round trips when sequentially reading large cold files while keeping the 64 KiB transport page size unchanged.
