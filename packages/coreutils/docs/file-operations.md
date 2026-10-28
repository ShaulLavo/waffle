# file-operations

Create, remove, copy and move files with touch, rm, cp and mv. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/cp` with a `/bin` alias.

```ts
import { coreutils } from "waffle-coreutils";
import { installPrograms } from "waffle/programs";

const installed = await installPrograms(runtime, [coreutils], { launcher });
// The caller owns its runtime and generic preview1 launcher.
await installed.dispose();
```

Installing the family does not fetch or start programs. The runtime owns markers, conflicts,
first-use source admission, process lifetimes and disposal. `waffle-base` includes this
family with the other everyday programs. See [installing program packages](../../../docs/guides/install-program-packages.md).

## Checked behavior

- `touch` creates empty files, keeps existing file contents, handles multiple operands, and supports `-c` and `--`.
- `rm` removes files, supports `-f`, removes nested trees with `-r`, refuses directories without recursive mode, and continues after a missing operand.
- `cp` preserves binary contents, overwrites files, supports `-n`, copies into directories, copies trees with `-R`, and refuses a source copied onto itself.
- `mv` renames files and directories, moves files into directories, preserves both operands with `-n`, and replaces destinations with `-f`.
- Each program resolves relative operands from the shell's current directory. Missing source or parent paths produce a nonzero status and a diagnostic. `--` permits operands beginning with `-`.

These are the checked common cases, not a full GNU compatibility claim. Upstream handles parsing and I/O without local rewrites. Diagnostics need not match GNU wording.

## Source and verification

The current entry is [src/bin/file_operations/mod.rs](../src/bin/file_operations/mod.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/file-operations.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
