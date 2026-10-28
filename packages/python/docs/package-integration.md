# Package integration boundary

`createPythonProgram` is the complete family-owned implementation: canonical path, CPython argv0, lazy raw-WASM loading, verified standard-library preparation and disposal. It neither creates nor owns a Waffle runtime and has no Bash dependency.

The current Waffle main snapshot `54379c9fa64d2174fbf38c165af8eb28fcde5113` exports `Runtime.registerProgram` and `registerAdapter`, and both return release leases. Its public `writeFile` accepts `{ exclusive: true }`, which the qualified payload owner uses for atomic creation. Its generic `browser/preview1-worker` is sufficient for CPython's WASI imports.

Waffle step 2 must provide the generic package operation that:

1. Reserves `/usr/bin/python`, creates/validates the executable marker, and joins rollback/disposal with `PythonProgram.dispose()`.
2. Registers `PythonProgram.source` as ordinary interruptible WASI, never a trusted cooperative module.
3. Launches through the shared generic preview1 worker, replacing only argv[0] with `PythonProgram.argv0` and preserving the remaining argv exactly.
4. Joins installer disposal with `PythonProgram.dispose()` while preserving changed-file-safe cleanup and borrowed identical files. Waffle already supplies the exclusive-create filesystem operation.
5. Preserves cwd independently of `PWD`, environment, descriptors, process supervision and the caller's single runtime.

The family package then needs only a thin `installPython` wrapper around that real API. No family worker, runtime adapter, Bash import or compatibility branch belongs here. The Node and Chromium harnesses register these pieces explicitly to test current Waffle; they are not production installation code.

## Monorepo installation

Use `installPython` from `@waffle/python/install` with the page's existing `Runtime` and
preview1 launcher. It passes `createPythonPackage` to `waffle/programs` and wraps only
that installation's launcher with `pythonLauncher`. The qualified CPython startup patch
calls `chdir(getenv("PWD"))`, so the wrapper sets `PWD` to `context.request.cwd` before
calling the supplied launcher. Other environment entries, argv, descriptor bindings and
process context are preserved. This also handles callers that omit PWD or pass a stale one.

```ts
import { installPython } from "@waffle/python/install";
const installed = await installPython(runtime, { launcher });
```

Callers composing `createPythonPackage` directly must use `pythonLauncher` from
`@waffle/python/launcher` for that installation. It creates no worker or runtime.

The producer's `dist/` is an intermediate artifact directory. Run
`bun run --cwd packages/python prepare:package /path/to/qualified-artifact` to verify and
stage the qualified interpreter, payload, receipt and notices into the public `assets/`
directory before packing. Packing checks these files and every manifest payload hash;
it does not run the producer or download assets.
