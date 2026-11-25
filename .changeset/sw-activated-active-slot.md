---
"@waffle-os/runtime": patch
---

`activated()` no longer hangs in WebKit when two pages register the same service worker at once. A worker already in the registration's active slot now counts as activated; only an installing or waiting worker is awaited.
