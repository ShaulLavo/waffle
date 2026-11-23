---
"@waffle-os/runtime": patch
---

Installing a program package writes its command markers in three batched filesystem steps instead of two requests per program, so a page that installs the base utilities becomes ready sooner.
