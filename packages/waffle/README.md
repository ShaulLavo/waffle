# @waffle-os/runtime

A WebAssembly runtime that lets programs run and work together in a browser tab.

A page creates one runtime. Programs borrow its filesystem, processes, pipes, and network instead of each bringing their own. [Bash Web](https://github.com/ShaulLavo/bash-web) and [our browser build of Bun](https://bun.sprockt.dev/) run on it.

## Install

```sh
npm install @waffle-os/runtime
```

Or with Bun:

```sh
bun add @waffle-os/runtime
```

## Quick start

Create `fs-worker.ts` so your build includes Waffle's filesystem service:

```ts
import "@waffle-os/runtime/browser/fs-worker";
```

Create `app.ts`:

```ts
import { createRuntime } from "@waffle-os/runtime";

const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
});
try {
  await runtime.filesystem.writeFile("/hello.txt", "hello from Waffle");
  console.log(new TextDecoder().decode(await runtime.filesystem.readFile("/hello.txt")));
} finally {
  await runtime.dispose();
}
```

Bundle both entries (for example with Bun):

```sh
bun build ./app.ts ./fs-worker.ts --outdir ./public --target browser --splitting
```

Serve `public/` with cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). The runtime requires `SharedArrayBuffer`, which browsers only expose on cross-origin isolated pages.

## Why Waffle

- **One tree for every program.** WASI alone gives each program its own world. Waffle adds pids, jobs, signals, pipes between processes, and one shared filesystem that the page and every guest see.
- **Calls stay synchronous.** A guest blocks in `Atomics.wait` on shared memory while the page and other workers serve it, so WASI Preview 1 semantics hold.
- **Pay for what you use.** The core bundle stays small; the process service loads on the first spawn.
- **Honest durability.** A write returns when memory has it; call `flush()` to wait for IndexedDB.

## Documentation

- [Getting started](https://github.com/ShaulLavo/waffle/blob/main/docs/getting-started.md)
- [Guides](https://github.com/ShaulLavo/waffle/blob/main/docs/README.md#guides)
- [Concepts](https://github.com/ShaulLavo/waffle/blob/main/docs/concepts.md)
- [Reference](https://github.com/ShaulLavo/waffle/blob/main/docs/README.md#reference)
- [Status and limits](https://github.com/ShaulLavo/waffle/blob/main/docs/status.md)
- [Troubleshooting](https://github.com/ShaulLavo/waffle/blob/main/docs/troubleshooting.md)
- [Landing site](https://waffle.shaulavo.dev/)

## License

MIT
