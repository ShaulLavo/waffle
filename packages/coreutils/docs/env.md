# env

Edit the environment, print it, or run another installed program. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/env` with a `/bin` alias.

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

## Commands

`env NAME=value node file.js args` runs the installed `node` program with the edited environment. Waffle resolves `#!/usr/bin/env node` scripts through its generic interpreter dispatch. Node must be installed on the same runtime and filesystem.

The upstream parser supports `-i`, `-u NAME`, assignments, `-S` splitting, `-C DIR`, `-a ARGV0`, and `-v`. Unsets precede assignments. `-S` expands `${NAME}` from the inherited environment before `-i` clears it. Options precede assignments.

The child receives argv0 as the command was given, or the exact `-a` value. Empty arguments, spaces and literal shell characters are preserved. There is no shell command-string wrapper. PATH lookup uses the edited environment; absent PATH defaults to `/bin:/usr/bin`, empty components mean cwd, and a slash bypasses PATH.

`-i` produces an empty child environment unless assignments add entries. Cwd comes from Waffle's process request, independently of `PWD`. `-C` changes cwd without rewriting `PWD`. The parent shell's environment and cwd are unchanged. A program's own adapter may apply its own environment policy.

Real child exit codes pass through. Missing commands return 127; commands that cannot start return 126. Local usage errors return 125. `env -0 COMMAND` and `env -C DIR` without a command remain usage errors.

The backend uses `waffle-process-consumer` on the existing runtime, inherits Waffle's generic launch descriptor snapshot, and waits for its child job's cleanup. Waffle owns fatal-caller cancellation. Execution uses spawn/wait rather than native process-image replacement.

## Printing and restrictions

Without a command, env prints the resulting environment. Newline and `-0` NUL separators, repeated assignments, unsets, and split strings retain upstream behavior. For example, `env -i -S 'A=one B="two words"'` prints `A=one\nB=two words\n`.

Signal disposition options `--ignore-signal`, `--default-signal`, `--block-signal`, and `--list-signal-handling` return 125 before input or execution. Non-UTF-8 process strings are explicitly unsupported. There is no native host execution fallback.

## Source and verification

The current entry is [src/bin/env.rs](../src/bin/env.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/env.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
