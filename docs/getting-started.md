# Getting started

In this tutorial you build a small page that starts a Waffle runtime, writes a file into its filesystem, reads it back, and prints it. It takes a few minutes and needs [Bun](https://bun.sh), because Waffle's `prepare` step runs `bun prepare.ts` and the tutorial bundles and serves with Bun. The steps were run with Bun 1.4.4, the version CI uses.

Waffle is a library for a browser app, not a command-line shell. The page creates one runtime. Bash Web and Bun are programs that borrow that runtime. See [Bash Web](https://github.com/ShaulLavo/bash-web) and [the Bun browser demo](https://bun.sprockt.dev/) for complete applications.

## Install

Install `waffle` as an exact Git dependency and trust its build step:

```sh
bun add github:ShaulLavo/waffle#4b9b6c668a59bd5aa52f0b87c3d76090b03706c3 --trust
```

You should see the package line and no "Blocked 1 postinstall" warning:

```text
installed waffle@github:ShaulLavo/waffle#4b9b6c6

1 package installed
```

The command writes the `waffle` dependency and `trustedDependencies` into `package.json`. The commit above is a real revision, not a moving branch. Change the pin when you adopt a newer Waffle revision. The `prepare` step that `--trust` allows writes the Node entry points under `dist/`. Browser bundlers read the TypeScript source and do not need them.

## Write the page

Create `fs-worker.ts`. It makes your build include Waffle's filesystem service:

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

`mode: "memory"` selects a disposable in-memory filesystem, so this example never touches saved workspaces. [Persist the filesystem](guides/persist-the-filesystem.md) shows the other modes.

Create `public/index.html`:

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

## Build

Bundle both entries into `public/`:

```sh
bun build ./app.ts ./fs-worker.ts --outdir ./public --target browser --splitting
```

`public/` now holds `app.js`, `fs-worker.js` and a few chunk files.

## Serve with isolation headers

The runtime needs `SharedArrayBuffer`. Browsers only provide it on a cross-origin isolated page, which means the server must send two headers. Create `serve.ts`:

```ts
Bun.serve({
  port: 8080,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file("./public" + (path === "/" ? "/index.html" : path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    });
  },
});
```

Start it and open <http://localhost:8080>:

```sh
bun serve.ts
```

The page prints:

```text
hello from Waffle
```

Opening the HTML file directly from disk does not work, and neither does a server that omits the headers. Without them the console shows `SharedArrayBuffer is not defined`. Other symptoms are in [Troubleshooting](troubleshooting.md). Production hosts must send the same headers, and must use HTTPS unless they serve `localhost`.

## Next steps

- [Run a WASI program](guides/run-a-wasi-program.md): register a program and spawn it from the page.
- [Persist the filesystem](guides/persist-the-filesystem.md): keep files between page loads.
- [Concepts](concepts.md): who owns what, and why a guest never creates its own runtime.
- [Status and limits](status.md): what works today and what does not.
- [Architecture and API notes](architecture.md) and [Host ABI](host-abi.md): the full reference.
- [Development](development.md): repository setup and checks.
