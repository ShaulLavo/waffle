<h1 align="center">Waffle</h1>
<p align="center">A WebAssembly runtime that lets programs run and work together in a browser tab.</p>
<p align="center">
  <a href="https://github.com/ShaulLavo/waffle/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ShaulLavo/waffle/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

A page creates one runtime. Programs borrow its filesystem, processes, pipes and network instead of each bringing their own. [Bash Web](https://github.com/ShaulLavo/bash-web) and [our browser build of Bun](https://bun.sprockt.dev/) run on it.

```ts
import { createRuntime } from "waffle";

const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
try {
  await runtime.filesystem.writeFile("/hello.txt", "hello from Waffle");
  console.log(new TextDecoder().decode(await runtime.filesystem.readFile("/hello.txt")));
} finally {
  await runtime.dispose();
}
```

```text
hello from Waffle
```

That is the browser console of a cross-origin isolated page. [Getting started](docs/getting-started.md) builds and serves it step by step.

## Why

- **One tree for every program.** WASI alone gives each program its own world. Waffle adds pids, jobs, signals, pipes between processes and one shared filesystem that the page and every guest see.
- **Calls stay synchronous.** A guest blocks in `Atomics.wait` on shared memory while the page and other workers serve it, so Preview 1 semantics hold.
- **Pay for what you use.** The core bundle is 8,779 bytes gzipped. The process service loads on the first spawn. `bun run size` enforces the core budget.
- **Honest durability.** A write returns when memory has it. Call `flush()` to wait for IndexedDB. [Storage](docs/storage.md) says exactly what survives a closed tab.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/waffle-overview.dark.svg">
  <img alt="The page owns a filesystem worker, a process supervisor and a loopback network. Guest workers use the filesystem and process services, talk to each other through pipes, and reach the network through shared rings. The filesystem checkpoints to IndexedDB or memory." src="docs/assets/waffle-overview.light.svg">
</picture>

The page owns every service. Guests only borrow them, and they never create a second runtime.

## Quick start

Waffle is a library for a browser app, so there is no CLI. Install it with [Bun](https://bun.sh), because Waffle's `prepare` step runs `bun prepare.ts`. Nothing is published to npm, so the command pins an exact commit and trusts Waffle's build step:

```sh
bun add github:ShaulLavo/waffle#4b9b6c668a59bd5aa52f0b87c3d76090b03706c3 --trust
```

Then:

1. Add `fs-worker.ts` (`import "waffle/browser/fs-worker";`) and the example above as `app.ts`.
2. Bundle both entries with `bun build ./app.ts ./fs-worker.ts --outdir ./public --target browser --splitting`.
3. Serve `public/` with the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers, then open the page and its console. The runtime needs `SharedArrayBuffer`, which browsers give only to cross-origin isolated pages.

[Getting started](docs/getting-started.md) has the HTML file, a short Bun server that sets the headers, and the failure you see without them. These steps were run with Bun 1.4.4, the version CI uses.

## What you can do

- Run a WASI program from the page: [Run a WASI program](docs/guides/run-a-wasi-program.md).
- Keep files between page loads: [Persist the filesystem](docs/guides/persist-the-filesystem.md).
- Read, search and snapshot a workspace: [WorkspaceVfs](docs/workspace-vfs.md) and [workspace search](docs/workspace-search.md).
- Give guests loopback TCP and previews: [Networking](docs/network.md).
- Write an adapter for a new guest engine: [Guest executor extensions](docs/architecture.md#guest-executor-extensions) and [Host ABI](docs/host-abi.md).
- Fix a page that does not start: [Troubleshooting](docs/troubleshooting.md).

## How it works

The page calls `createRuntime()` once. The runtime starts a filesystem worker that owns the file tree in shared memory. Each process runs in its own worker and reads and writes that shared memory directly. The page-side supervisor tracks pids, jobs and signals, and loads on the first spawn. Pipes and TCP sockets are rings in shared buffers. [Concepts](docs/concepts.md) walks through the ownership rules and the life of a spawn.

## Docs

[Getting started](docs/getting-started.md) · [Guides](docs/README.md#guides) · [Concepts](docs/concepts.md) · [Reference](docs/README.md#reference) · [Status and limits](docs/status.md) · [Troubleshooting](docs/troubleshooting.md) · [ADRs](docs/adr) · [Development](docs/development.md) · [Landing site](https://waffle.shaulavo.dev/)

## Status

Pre-1.0 and experimental. `package.json` says `0.0.89` and `private: true`. There are no tags or releases and nothing on npm, so consumers pin a commit. Waffle promises no compatibility with older revisions.

- SAFE filesystem mode is reserved. `mode: "safe"` throws `UNSUPPORTED_VFS`.
- Persistent storage has one writer at a time. A second tab waits or takes over.
- CI runs the browser suites in Chromium, Firefox and WebKit on Linux. Nothing is verified on iOS or Android.

[Status and limits](docs/status.md) has the full list and the numbers.

## License and contributing

[MIT](LICENSE). Adapted upstream code is listed in [docs/bun-patches.md](docs/bun-patches.md) and its licenses are in [LICENSES/](LICENSES/). To change the code, start with [Development](docs/development.md) and [AGENTS.md](AGENTS.md). Report security issues through [SECURITY.md](SECURITY.md).
