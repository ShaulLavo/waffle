# Python

`@waffle/python` prepares the official CPython 3.15.2 `wasm32-wasip1` interpreter for the Waffle runtime the page already owns. The public installer is `installPython`; it borrows the caller's runtime and generic launcher.

```ts
import { installPython } from "@waffle/python/install";
const python = await installPython(runtime, { launcher });
// Spawn /usr/bin/python with the caller's existing process controller.
await python.dispose();
```

`installPython` is the production composition with Waffle's generic installer. It uses
`createPythonPackage`, whose launch policy sets PWD so requested cwd wins over missing or
stale PWD. Lower-level `createPythonProgram` remains the payload/source implementation.

The program path is `/usr/bin/python`, and its fixed CPython argv0 is `/cross-build/wasm32-wasip1/python.wasm`. `createPythonProgram` is lazy: construction does not fetch the interpreter or payload. The first `source()` call loads the interpreter and prepares the payload, and concurrent calls share that work.

Serve `python.wasm`, `python-stdlib.json`, `python-files/**`, and `python.NOTICES.txt` from the qualified [Python build](python-build.md). The manifest's file URLs resolve relative to its URL. Defaults point to the package's `assets/` files. Keep the manifest and its full unpruned payload together; the interpreter is a separate asset, never a duplicate VFS file.

The Waffle package installer registers the executable and starts it through Waffle's generic process path. Every payload file's byte count and SHA-256 must match before any file is installed, and filesystem drain completes before the interpreter can launch. Successful later spawns reuse the cached program. A failed attempt rolls back unchanged files it created and lets a later spawn retry.

The supported slice is `--version`, `-c`, script files and arguments, standard-library imports including `json`, `os`, `sys`, and `sysconfig`, ordinary guest file I/O, stdin/stdout/stderr, exit status, and the caller's requested cwd for `os.getcwd()` and relative paths. Subprocesses, threads, sockets, pip, dynamic native extensions, and interactive REPL behavior are outside this slice. This is a WASI build, not a promise that every CPython module works in a browser.

## Options and payload ownership

`PythonOptions` accepts either raw-byte `source` or `wasmUrl`; there is no `workerUrl` option because worker selection belongs to Waffle's package installer. Supply either `payloadUrl` or `payload`, where `payload` is a `PythonPayloadManifest` or a lazy function returning one. If omitted, the interpreter and manifest default to the package's `assets/` files. A supplied manifest's relative file URLs resolve against the manifest URL; use absolute file URLs when relocating a supplied manifest.

The exported manifest types describe format `1`, CPython commit `5e58eaad7c58df58dfa8ea549c87996e01dd1077`, argv0 `/cross-build/wasm32-wasip1/python.wasm`, and regular files with canonical absolute `path`, `url`, nonnegative safe integer `bytes`, and lowercase hexadecimal `sha256`. Empty regular files are included. Allowed paths are `/Lib/**`, `/cross-build/wasm32-wasip1/pybuilddir.txt`, and `/cross-build/wasm32-wasip1/build/lib.wasi-wasm32-3.15/**`. The full library, actual build marker, and generated sysconfig tree are build outputs. The launcher replaces only argv element zero, preserving all user arguments.

Existing identical regular files are borrowed. Different files, directories, and symlinks at payload file paths cause a collision; missing files use exclusive creation. Parent components must be directories. Reserve these payload paths while preparing Python: the shared filesystem does not provide an atomic tree swap against unrelated concurrent edits.

`dispose()` joins active loading and removes only files this program created whose bytes remain unchanged. It leaves directories, borrowed or changed files, and Python-created caches in the caller's tree. It never unregisters a Waffle program, removes a whole payload tree, or disposes the runtime; the package installer owns registration release. Call disposal after Python processes have stopped. If the caller already disposed its runtime, the program makes no further filesystem calls.

The payload unit tests cover loading, hashes, collisions, rollback, retries, and disposal races; launcher tests cover argv0. The browser acceptance suite separately qualifies the real build artifact and supported command slice on the pinned Waffle runtime.
