---
"@waffle-os/runtime": patch
---

Keep sleeping Workers from stalling process starts on WebKit: blocking waits wake at growing intervals and allocate a little so the engine can finish an open garbage collection.
