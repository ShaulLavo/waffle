# tail

Print final lines from standard input or one file. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/tail` with a `/bin` alias.

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

- `tail` and `tail file` write the last 10 lines.
- `tail -n N` and `tail -nN` select the last `N` lines. Zero writes no bytes.
- `--` ends option parsing. A file named `-` selects standard input.
- Output preserves every input byte, including NUL, CRLF, and a missing final newline.
- The utility reads standard input through EOF before writing. It retains only the requested number of complete records and the current partial record, up to 16 MiB in total. Exceeding that bound returns status 1 with a diagnostic.
- Invalid options, counts, and extra file operands return status 2. An input open or read failure returns status 1 and writes a diagnostic to standard error.

## Left out

Multiple input files, filename headers, `-c`, `-f`, and other GNU `tail` options are not supported.

## Source and verification

The current entry is [src/bin/tail.rs](../src/bin/tail.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/tail.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
