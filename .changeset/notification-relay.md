---
"@waffle-os/runtime": patch
---

A page now runs one notification relay Worker for all its processes instead of one per process, and the relay waits on filesystem, network and process words only while a process is blocked in a notification wait. A process that never blocks there, such as Bun on the Browser engine, starts no blocking-wait Workers and costs the relay nothing. Filesystem revocation and reap now advance the watch word as well as notifying it.
