# File operations

`touch`, `rm`, `cp`, and `mv` are separate upstream uutils programs compiled for WASI. Each has its own `bash-web/utilities/<name>` entry and loads only on first use. They operate on the caller's Waffle filesystem. They are not builtins and add nothing to the shell engine.

## Install

```ts
import { installTouch } from "bash-web/utilities/touch";
import { installRm } from "bash-web/utilities/rm";
import { installCp } from "bash-web/utilities/cp";
import { installMv } from "bash-web/utilities/mv";

const installation = await installCp(runtime, { wasmUrl: cpUrl, workerUrl });
```

The other entries export `installTouch`, `installRm`, and `installMv` with the same options. `WasiUtilityOptions.source` accepts raw bytes or a lazy bytes loader instead of a URL. A precompiled module is not accepted. Waffle owns source admission and interrupt instrumentation. Installation creates no program worker and fetches no guest. Stop active processes before calling `installation.dispose()`. The caller retains ownership of the runtime.

## Checked behavior

- `touch` creates empty files, keeps existing file contents, handles multiple operands, and supports `-c` and `--`.
- `rm` removes files, supports `-f`, removes nested trees with `-r`, refuses directories without recursive mode, and continues after a missing operand.
- `cp` preserves binary contents, overwrites files, supports `-n`, copies into directories, copies trees with `-R`, and refuses a source copied onto itself.
- `mv` renames files and directories, moves files into directories, preserves both operands with `-n`, and replaces destinations with `-f`.
- Each program resolves relative operands from the shell's current directory. Missing source or parent paths produce a nonzero status and a diagnostic. `--` permits operands beginning with `-`.

These are the checked common cases, not a full GNU compatibility claim. Upstream handles parsing and I/O without local rewrites. Diagnostics need not match GNU wording.

## Runtime limits

Waffle's current WASI metadata does not provide ordinary POSIX permissions and timestamps. The checks compare directory entries, actual file bytes, stdout, exit status, and diagnostic presence. They do not establish timestamp changes, ownership, permission preservation, hard links, or cross-filesystem moves.

With terminal stdin, plain `mv input existing` currently asks `mv: overwrite 'existing'? ` and exits 1 on EOF or a negative response instead of replacing the destination. Upstream's WASI path sees `metadata.permissions().readonly()` as true. Both files remain unchanged. `mv -f input existing` succeeds. This is a recorded runtime limitation, not a local command workaround.

## Source and verification

The four individual `uu_*` packages and their shared `uucore` come from `uutils/coreutils` revision `07763857f6b9a547742a994b58aef0ccd036198b`. No upstream code is modified. `uucore_files` is a dependency alias, so registry `uucore` used by other utilities can coexist. `shell/utilities/file-operations.source.json` records package paths and the MIT license digest. Distribution notices include the upstream root license and transitive dependency licenses.

Each Rust bin uses a shared thin wrapper that initializes WASI libc's cwd from `PWD` and calls the upstream entry. Build one with `buildWasiShell(["-p", "shell-utilities", "--bin", "cp"])` from `scripts/wasi-build.ts`. The existing helper supplies wasi-sdk 34.0, Waffle's patched libc, the 256 MiB cap, and the guest verifier.

`scripts/owned-fixtures/file-utilities.json` contains additive observations recorded once with Bash 5.3.15 and identified GNU coreutils binaries. Both qualification runners replay those exact records. They never invoke host Bash or coreutils. Existing protected fixtures and score baselines are unchanged.

The shared reader parses the complete record from `unknown`, checks exact binary identities and case identities, and validates statuses, byte arrays, diagnostics, directory parents, and the runtime-gap record. It seals the original 17,583 bytes with SHA256 `7b64ee02c7430f2c1534dabd6d424abec48d1efec1329216b6a04904cde32ead`. A separate context digest binds the recording environment and initial tree shared by the recorder and both runners.

After building the shell, utilities, workers, and Node harness, run `npm run build:file-utilities:tests`. `node --test scripts/test-own-shell-file-utilities.ts` checks the real guests on caller-owned Waffle. `npm run test:file-utilities:browser` checks them in Chromium and Firefox, including independent lazy loads, installation disposal, cancellation, caller runtime reuse, and worker cleanup.
