---
"@waffle-os/runtime": patch
---

Pipelines between programs no longer move one write every 4 ms: the page relays pipe data as soon as a pipe changes. Guests that poll for signals between work steps no longer pay for two full scans of the signal table when nothing is pending.
