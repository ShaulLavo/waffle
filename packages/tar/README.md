# Waffle tar

Optional uutils `tar` for Waffle, built as a real WASI guest.

```ts
import { tar } from "waffle-tar";
await runtime.programs.onDemand(tar.pick("tar"));
```

`/usr/bin/tar` and `/bin/tar` share one lazy program. Listing, gzip and stdin
pipelines are implemented upstream. Create and extract fail before filesystem
changes on WASI because the runtime cannot supply ownership or restore archive
permissions. This is a bounded candidate, not a qualified read/write tar package.

See [compatibility](docs/compatibility.md), [build and verification](docs/build.md),
and [pinned provenance](sources.lock.json).
