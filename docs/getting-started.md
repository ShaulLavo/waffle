# Getting started

Waffle is a library for an application that runs in the browser, not a command-line shell.
The page creates one runtime. Bash Web and Bun are programs that borrow that runtime; see
[their repositories](https://github.com/ShaulLavo/bash-web) and
[the Bun browser demo](https://bun.sprockt.dev/) for complete applications.

## Install

Add `waffle` as an exact Git dependency and trust its build step in `package.json`:

```json
{
  "dependencies": {
    "waffle": "github:ShaulLavo/waffle#4087eae447fc536b6c0a78e5f14b8049be11c467"
  },
  "trustedDependencies": ["waffle"]
}
```

Run `bun install`. The commit above is a real revision, not a moving branch; update the pin
when adopting a newer Waffle revision. Installation's `prepare` step emits the Node exports
under `dist/`. Browser bundlers consume the TypeScript source.

## A small browser page

Create `fs-worker.ts` so your build includes Waffle's filesystem service:

```ts
import "waffle/browser/fs-worker";
```

Create `app.ts`:

```ts
import { createRuntime } from "waffle";

const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
});
try {
  await runtime.filesystem.writeFile("/hello.txt", "hello from Waffle");
  const bytes = await runtime.filesystem.readFile("/hello.txt");
  document.body.textContent = new TextDecoder().decode(bytes);
} finally {
  await runtime.dispose();
}
```

Bundle both entries with Bun:

```sh
bun build ./app.ts ./fs-worker.ts --outdir ./public --target browser --splitting
```

Add a `public/index.html` that loads the page entry:

```html
<!doctype html>
<html lang="en">
  <meta charset="utf-8" />
  <title>Waffle example</title>
  <body>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

Serve `public/` over HTTPS (or localhost) with these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Those headers enable cross-origin isolation and `SharedArrayBuffer`, which the runtime needs.
Opening the HTML file directly does not work. The page should print `hello from Waffle`.
The example uses a disposable in-memory filesystem, so it does not change saved workspaces.

## Running programs

Creating a runtime does not install a shell or Bun. A consumer supplies the compiled WebAssembly
program and a worker adapter, registers both, and launches through the runtime's process service.
Program registrations use absolute canonical paths, and the caller creates the corresponding
filesystem file before spawning. Read [registration and executable paths](architecture.md#registration-leases),
[worker adapter hooks](architecture.md#guest-executor-extensions), and the
[guest/host contract](host-abi.md) before writing an adapter.

## Next steps

- [Architecture and API notes](architecture.md): services, handles, processes and pipes.
- [Host ABI](host-abi.md): guest imports, wait results and startup errors.
- [Runtime startup](runtime-startup.md): observing initialization without console logging.
- [Development](development.md): repository setup, gates and further reference links.
