---
"@waffle-os/runtime": patch
---

`startCommand` now gives the command pipes for the standard descriptors it provides, as a captured command gets on Unix, so `isatty` is false and programs do not colour their captured output. Pass `terminal: true` to present them as a terminal instead.
