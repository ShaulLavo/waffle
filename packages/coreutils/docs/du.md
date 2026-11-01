# Du source candidate

This leaf delegates to real `uu_du` 0.13.0 at revision
`07763857f6b9a547742a994b58aef0ccd036198b`. Its original entry reuses the
family cwd helper on WASI. It contains no disk-usage implementation or metadata
substitute. The source hashes and MIT notice are in `provenance/du.source.json`.

Du is not registered or packaged as a supported Waffle guest. The accepted
source inventory stays at 20 coreutils programs and 25 aggregate programs,
with 40 and 50 executable paths respectively.

## Qualification boundary

The unchanged upstream code assumes Unix metadata on every non-Windows target,
reads allocated blocks even for `--bytes`, and spawns a printing thread.
WASI preview1 has no allocated-block field. Waffle's `FileStat.size` describes
logical length, not physical allocation, and its filesystem adapters do not
expose a disk-allocation capability. A sparse file can have a nonzero apparent
size with no allocated data blocks. Converting size to rounded blocks or
inventing a zero-block field would misrepresent disk use.

A portable upstream implementation must separate apparent-size and inode modes
from allocated storage, and avoid an OS printing thread on single-threaded
WASI. Allocated-size requests must fail explicitly while the filesystem lacks
an allocation capability. Adding that capability belongs to Waffle's runtime
and filesystem owners, not this leaf. The current candidate makes none of
those changes and does not claim those modes work in Waffle.

## Reproduction

Shared workspace, lock and locale integration must be supplied before the
candidate build entry can run. With those rows applied in an owned source copy,
`node packages/coreutils/scripts/build-du.ts` invokes only the existing isolated
program route. A compiler rejection is not a qualified Wasm artifact.

The bounded native comparison uses owned files, directories, hard links,
symlinks and a sparse file. It verifies the exact GNU executable version and
SHA-256 before comparisons, applies a deadline to every process, records raw
stdout and stderr bytes, and removes fixtures in `finally`:

```sh
DU_SCRATCH_ROOT=/your/owned/data-drive/scratch \
  node packages/coreutils/scripts/du-oracle.ts /your/native/du
```

Its 28 cases compare exact statuses, stdout rows and stderr presence. Directory
iteration order is ignored, but raw output is retained. Apparent-size parity
cases use file operands because upstream ignores directory metadata lengths.
Native qualification cannot establish WASI behavior. No fake guest, native
fallback, catalog admission or archive qualification replaces a rejected build.
