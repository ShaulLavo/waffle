---
"@waffle-os/runtime": patch
---

Small writes and package installs run faster. Persistent filesystem reads use an in-memory cache, and the client keeps path lookups cached through large builds. The npm package no longer includes tests, and the pipe registry reserves less memory.
