# @waffle-os/runtime

A WebAssembly runtime that lets programs share one filesystem, process tree, pipes, and loopback network in a browser tab.

## Install

```sh
bun add @waffle-os/runtime
```

## Quick start

Register the filesystem worker (`fs-worker.ts`):

```ts
import "@waffle-os/runtime/browser/fs-worker";
```

Create one runtime per cross-origin isolated page (`app.ts`):

```ts
import { createRuntime } from "@waffle-os/runtime";

const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
await runtime.filesystem.writeFile("/hello.txt", "hello from Waffle");
console.log(new TextDecoder().decode(await runtime.filesystem.readFile("/hello.txt")));
await runtime.dispose();
```

## Links

[Getting started](https://github.com/ShaulLavo/waffle/blob/main/docs/getting-started.md) · [Docs](https://github.com/ShaulLavo/waffle/blob/main/docs/README.md) · [Landing site](https://waffle.shaulavo.dev/)
