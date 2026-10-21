# Waffle

Waffle is a WebAssembly runtime that lets programs run and work together in a browser tab; Bash Web and our browser build of Bun run on it.

## Install

Pin an exact Git commit in your `package.json`, then run `bun install`:

```json
{
  "dependencies": { "waffle": "github:ShaulLavo/waffle#fc58a532f0d7a617e631ea4b7580a190915d4ed6" },
  "trustedDependencies": ["waffle"]
}
```

## Example

In a cross-origin isolated page, with [the filesystem worker bundled](docs/getting-started.md):

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

[Site](https://waffle.shaulavo.dev/) · [Getting started](docs/getting-started.md) · [Architecture](docs/architecture.md) · [Host ABI](docs/host-abi.md) · [Startup](docs/runtime-startup.md) · [Storage](docs/storage.md) · [Development](docs/development.md)
