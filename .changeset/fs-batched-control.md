---
"@waffle-os/runtime": patch
---

A filesystem client no longer sends a separate port message to discard each consumed reply or to ask for a capability trim. Both ride on its next request, and a microtask sends whatever no request carried. A blocked guest now pays one message per filesystem call instead of up to three.
