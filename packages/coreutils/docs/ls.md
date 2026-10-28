# ls

List directory entries with the pinned uutils implementation. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/ls` with a `/bin` alias.

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

## Supported behavior

The qualified C-locale cases cover default listing, `-a`, `-1`, `-d`, absolute and relative paths, files before directory operands, sorted multiple directories with headers, empty directories, and missing-path status 2. Captured nonterminal output matches GNU coreutils 9.12 byte for byte, including spaces in names. Terminal output uses upstream columns and quoting instead.

The wrapper sets libc's working directory from the shell's `PWD` before upstream entry. Without that step, WASI starts in `/` and `ls` without an operand ignores `cd`.

Symlink targets, hard-link counts, ACLs, ownership lookup, security contexts, terminal-width parity, non-C locale collation, and recursive large-tree behavior are not qualified. Waffle capabilities remain Waffle's responsibility. No link or permissions substitute is included here.

## Source and verification

The current entry is [src/bin/ls.rs](../src/bin/ls.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/ls.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
