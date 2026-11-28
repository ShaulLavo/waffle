# Waffle grep

`@waffle-os/grep` packages FreeBSD `grep` `2.6.0-FreeBSD` under the BSD-2-Clause license, compiled to `wasm32-wasip1` for Waffle runtimes. Pass the `grep` catalog to `installPrograms` to install `/usr/bin/grep` and `/bin/grep`.

```ts
import { grep } from "@waffle-os/grep";
import { installPrograms } from "@waffle-os/runtime/programs";

await installPrograms(runtime, [grep], { launcher });
```

Build and test:

```sh
bun run --cwd packages/grep prepare:package
bun run --cwd packages/grep test
```

See [docs/grep.md](docs/grep.md), [sources.lock.json](sources.lock.json), and [build-recipe.json](build-recipe.json).
