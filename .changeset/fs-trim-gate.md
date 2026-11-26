---
"@waffle-os/runtime": patch
---

The filesystem service no longer rescans every transient capability after each request. A scan runs only when the set is over its bound, when something was unlinked since the last scan, or while an unlinked capability is still referenced. Unlinked files are still collected as soon as their last reference goes.
