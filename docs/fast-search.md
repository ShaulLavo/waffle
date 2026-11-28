# Search commands

Install the `grep` catalog from `@waffle-os/grep` and the `ripgrep` catalog from
`@waffle-os/ripgrep` through Waffle's program installer. The runtime launches the compiled
FreeBSD `grep` and `ripgrep` WASI binaries.

```ts
import { grep } from "@waffle-os/grep";
import { ripgrep } from "@waffle-os/ripgrep";
import { installPrograms } from "@waffle-os/runtime/programs";

await installPrograms(runtime, [ripgrep, grep], { launcher });
```

Borrow the page's existing `runtime` and `launcher`. Installation registers `/usr/bin/rg`,
`/bin/rg`, `/usr/bin/grep`, and `/bin/grep` and loads each Wasm module on its first exec.

The retired `fastGrep` and `fastRipgrep` wrappers buffered whole files and formatted output in
host workers. They failed with `EFBIG` above 16 MiB of input or 32 MiB of output for one file.
The WASI commands stream through the normal launcher without those host buffer caps.
