---
"@waffle-os/runtime": patch
---

`PreviewServer.request()` takes an optional `{ signal }`. Aborting it closes the guest server's connection for that one request, and the sink hears nothing more.
