# Waffle grep

Real FreeBSD `grep` (`2.6.0-FreeBSD`, BSD-2-Clause) compiled to `wasm32-wasip1` for Waffle runtimes, with optional `fastGrep` search-worker acceleration.

```ts
import { grep, fastGrep } from "@waffle-os/grep";
```

Build and test:

```sh
bun run --cwd packages/grep prepare:package
bun run --cwd packages/grep test
```

See [docs/grep.md](docs/grep.md), [sources.lock.json](sources.lock.json), and [build-recipe.json](build-recipe.json).
