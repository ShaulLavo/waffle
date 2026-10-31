# head

Print initial lines or bytes. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/head` with a `/bin` alias.

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

- `-n COUNT`, `--lines COUNT`, and `--lines=COUNT` select lines. `-c COUNT`, `--bytes COUNT`, and `--bytes=COUNT` select bytes. Short options accept attached counts.
- Positive counts select a prefix. Negative counts print all but the last units. Counts support upstream size suffixes, including `b`, `K`, `KB`, and `KiB`. `-NUM` is the obsolete line-count form.
- `-q`, `--quiet`, and `--silent` suppress headers. `-v` and `--verbose` force headers. Multiple file operands get headers by default.
- `-z` and `--zero-terminated` use NUL-delimited records. `--help` and `--version` use upstream text.
- `--` ends option parsing. No file operands means standard input. A `-` operand reads standard input.
- Bytes pass through unchanged, including invalid UTF-8 and a missing final newline. Byte counts can split a multibyte character.
- Missing files and invalid arguments exit with status 1 and a diagnostic. A missing file does not prevent later operands from being read.
- Waffle admits the raw guest bytes through its ordinary WASI path, adds interrupt checks, and owns process cancellation. The guest does not claim cooperative execution.

## Differences from GNU head

Diagnostics are upstream uutils messages, not byte-for-byte GNU messages. The standard-input header is `==> standard input <==`, without GNU's quotes around `standard input`.

The WASI build uses upstream's non-Unix buffered stdin path. It can discard bytes beyond the requested prefix, including on redirected seekable stdin and between repeated `-` operands. Do not use consecutive `head` invocations or repeated stdin operands to divide one input. Named file operands and separate redirections work normally.

Negative counts need to retain a suffix and can use memory proportional to the requested count. The guest has the shared 256 MiB WASI memory cap.

## Source and verification

The current entry is [src/bin/head.rs](../src/bin/head.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/head.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
