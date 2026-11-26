---
"@waffle-os/runtime": patch
---

A filesystem client no longer sends a discard message for a reply the service keeps nothing for: an inline reply to stat, create, write, append, grow, resize, setTimes, setMode, read or readlink. Resolves, stages, walks, watches, workspace reads and overflowing replies are still discarded at once, as before. Requests also omit an absent publication admission, so the service decodes them on the plain JSON path.
