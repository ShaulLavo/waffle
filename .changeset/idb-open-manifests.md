---
"@waffle-os/runtime": patch
---

Reopening a saved IndexedDB workspace reads every stored file's manifest in one request instead of one transaction per file. A 17,000-file workspace now opens in about 0.4 to 0.7 s instead of 2 to 5 s in Chromium, Firefox and WebKit.
