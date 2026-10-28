# Find utility

`bash-web/utilities/find` installs `findutils` 0.11.0 as a separate ordinary WASI guest. Import `installFind` and pass the same Waffle runtime used by `createShell`.

```ts
import { installFind } from "bash-web/utilities/find";

const installation = await installFind(runtime);
// After its processes stop:
await installation.dispose();
```

## Supported behavior

The accepted scope includes starting paths, recursive descent, `-name`/`-path` glob matching, their case-insensitive forms, whole-path `-regex`, `-type`, `-empty`, byte and rounded-unit `-size` tests, logical expressions, `-mindepth`, `-maxdepth`, `-prune`, `-quit`, `-print`, `-print0`, and depth-first traversal. `-printf` accepts the qualified portable fields `%P`, `%f`, `%s`, and `%d`; `-fprint0` writes NUL-separated results to a file. The wrapper sets WASI's working directory from the shell's `PWD`, so relative starting paths follow `cd`.

`-files0-from FILE` reads NUL-separated starting paths, including spaces, newlines, and names beginning with `-`. `-files0-from -` reads stdin. An empty input traverses nothing. An empty record reports an error and makes find exit with status 1, while later valid records still run. A read error stops that input and also fails.

```bash
find . -type f -iname '*.txt' -size +1c -print0
find sub -type f -printf '%P:%s\n'
find -files0-from roots -type f -print0
```

The guest is lazy. Installation creates `/bin/find` and registers the source loader without fetching, compiling, or starting a process. The first spawn supplies raw bytes to Waffle so it can instrument the ordinary WASI guest for interruption; later spawns reuse the admitted source.

This is not full GNU find parity. `-exec`, `-execdir`, `-ok`, and `-okdir` are rejected by the WASI expression parser with status 1 before traversal or starting-path input is read. They need child-process launch. Predicate operands remain data, so `find . -name -exec` is valid. `-xdev`, `-readable`, `-writable`, `-executable`, and Unix ownership, group, mount, and permission predicates are excluded because the aligned WASI/runtime metadata does not provide their authoritative behavior. `-delete`, links, time predicates, and other upstream options have no new compatibility claim in this change.

## Needs from other tracks

Traversal needs only Waffle's existing filesystem operations: directory reads (`fd_readdir`) and file metadata (`filestat`). No new runtime adapter or process-spawning path is added here.

Execution remains gated on the exact Waffle 0.0.90 host and Shell adapter. The reusable process consumer has spawn/wait, status, PATH lookup and explicit descriptor bindings, but the ordinary guest contract still lacks:

- Enumeration of every inherited descriptor, including sparse descriptor numbers. `runtime_proc.fd_kind(fd)` only answers for a known number.
- A working-directory startup capability independent of the environment. The Shell launcher currently injects `PWD`, and an arbitrary WASI child does not initialize libc cwd from that variable. Thus `-execdir` cannot promise both its containing-directory cwd and an unchanged environment.
- Child cleanup after the utility receives a fatal signal. The consumer owns an independent child job; P's `kill_job` signals only the specified job, and Rust cleanup does not run after fatal WASM termination.

The required descriptor operation must enumerate inheritable bindings, exclude private preopens, and define end/error results without retaining descriptors or launching services. Cwd must be applied before the child's entry point, separately from environment values. Until those contracts are available, no `-exec*` or `-ok*` mode is claimed, and no host-process fallback is added.

## Source and checks

The guest uses `findutils` 0.11.0 from `uutils/findutils` revision `505421d4e03586efeb7b9c55adf057599e192e0a`. `third-party/uutils-find` contains the find-only source from that revision. Its `wasi.patch` records the manifest/library extraction, invalid starting-record fix, and WASI execution-predicate rejection. `shell/utilities/find.source.json` records the original archive and license digests, the patch digest, every vendored source digest, and the accepted scope. The upstream MIT license is collected by `npm run notices:shell` from Cargo metadata.

Run `npm run build:shell`, `npm run build:utilities`, `npm run build:node-harness`, and `npm run test:find` for the focused Node-hosted Waffle cases and source receipt check. Run `npm run build:worker` and `npm run test:find:browser` for the real Chromium/Waffle cases. These commands need the WASI build prerequisites from [Development](development.md).

The expanded cases compare stdout bytes and status with native GNU find on the same fixture. They compare unordered records only where traversal ordering is unspecified; the depth-first case compares exact bytes. Diagnostics are checked for presence, because upstream error wording differs. Fixtures include spaces, newlines and shell-looking names. Browser checks also verify lazy loading, marker disposal, caller ownership, and closure of every worker. Native GNU find is only a test oracle.

Execution rejection checks cover semicolon and batch forms, skipped predicates, empty roots, unread starting-path input, and both prompt modes leaving stdin unread. Literal name, path, and format operands are compared with GNU find.
