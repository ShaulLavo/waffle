---
"@waffle-os/runtime": patch
---

A persistent workspace no longer fails running filesystem calls with `ECANCELED` ("host lease expired") when its lease renewal timer runs late behind a long task. The Host renews the lease and retries the call. A call still fails when another tab has taken over, the Host is stepping down, or the workspace is closing.
