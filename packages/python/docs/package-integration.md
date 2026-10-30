# Install Python on the caller's runtime

`installPython` from `@waffle/python/install` installs the package through the public
`waffle/programs` installer. The caller supplies its existing `Runtime` and generic
preview1 launcher. The family creates no runtime, worker or process service.

```ts
import { installPython } from "@waffle/python/install";
const python = await installPython(runtime, { launcher });
// Spawn /usr/bin/python through the caller's existing process controller.
await python.dispose();
```

The approved CPython startup patch establishes cwd from PWD. `createPythonPackage` wraps only
its program's launcher with `pythonLauncher`, setting PWD from
`context.request.cwd`. It handles missing or stale PWD while preserving other environment
entries, argv and descriptor bindings. The generic launcher receives the interpreter's
required argv0 and otherwise launches the real preview1 worker unchanged.

For explicit composition, `createPythonPackage` exports the exact `ProgramPackage` shape:
lazy `source`, canonical `/usr/bin/python`, interpreter `argv0`, and payload disposal.
The package carries its launch policy when passed to `runtime.programs` or `installPrograms`.

## Stage an accepted producer artifact

The producer's output directory is an intermediate artifact. The staging helper verifies
the externally accepted producer receipt SHA-256, pinned CPython/source-patch identity,
all 2,650 payload entries, interpreter admission and memory cap, and the receipt's asset
hashes before copying anything. The original `python-build.json` remains byte-identical;
consumer qualification records the current Waffle source separately.

```sh
bun run --cwd packages/python prepare:package --receipt-sha256 HEX /path/to/accepted-artifact
```

The public defaults read `assets/python.wasm` and `assets/python-stdlib.json`. Packing
checks the staged interpreter, payload files, notices, licenses and original receipt.
It does not rebuild CPython. Disposal waits for admitted processes, removes only owned
unchanged payload files, and preserves borrowed identical files and caller data.
