---
"@waffle-os/runtime": patch
---

Filesystem requests no longer wake every connection's revocation watcher. Revocation, reap and transport failure now also bump a second word in the shared signal, and the fs worker's per-session watchers and the clients' revocation monitors wait on that word alone. A package install's fs worker used to take about five extra tasks per request just to re-check revocation.
