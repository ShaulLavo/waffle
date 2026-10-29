# Opt-in process search

`fastRipgrep` and `fastGrep` keep the real program module installed. After normal module admission, a pure argument planner selects a host search process for the proven subset. Unsupported arguments and environments call the installation's original launcher unchanged.

```ts
import { fastRipgrep } from "waffle-ripgrep";
import { fastGrep } from "waffle-grep";
import { installPrograms } from "waffle/programs";
import searchUrl from "waffle/search/search-worker?worker&url";
import shardUrl from "waffle/search/shard-worker?worker&url";

await installPrograms(
  runtime,
  [
    fastRipgrep({ search: searchUrl, shard: shardUrl }),
    fastGrep({ search: searchUrl, shard: shardUrl }),
  ],
  { launcher },
);
```

The example uses Vite worker URL imports. Other bundlers must emit both worker entries and supply their URLs. Borrow the page's existing runtime and installation launcher.

The initial subset requires explicit text mode and recursive operands. Ripgrep also requires `--no-ignore --hidden`. Matching supports printable ASCII literals and literal alternation. Grep accepts only the qualified C and C.UTF-8 locale variants. Every other invocation runs the installed WASM program.

Ripgrep line output additionally requires an explicit `stdoutIsTTY: false` factory option. Set it only when the embedding knows stdout is not a terminal. Count and file-list output do not require that option when `--color never` is supplied.

Search runs with the original pid, environment, working directory and descriptors. Its workers share the process's filesystem fence. The engine resolves explicit symlinks but skips symlinks during recursive walking. It keeps one global window of 256 candidates. Files above 16 MiB, display paths above 4096 UTF-8 bytes and per-file output above 32 MiB produce errors. Pending output reservations have a 64 MiB bound. A resource error does not restart WASM after output.

The ordinary `ripgrep` and `grep` packages remain the default. This API is opt-in pending paired measurements; no speed claim is implied.
