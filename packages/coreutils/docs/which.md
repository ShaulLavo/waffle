# which

Query Waffle executable metadata without running candidates. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/which` with a `/bin` alias.

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

## Supported

- Search exported `PATH` entries in order. Print the first match, or every matching entry with `-a` or `--all`. Repeated PATH entries produce repeated results in all-match mode.
- An empty PATH entry means the current directory. Relative entries resolve from the process cwd. An unset PATH searches nowhere. An empty PATH searches only cwd.
- Names containing `/` bypass PATH and query that path directly.
- Print normalized absolute paths, one per line. The host walks the original path before normalization, so a non-directory component cannot disappear through `..`.
- Process every name. Return 0 when every name matches, 1 if any name is missing, and 2 for usage or host-query errors. Missing names produce no diagnostic. Waffle owns cancellation and its signal-derived status. A broken output pipe returns 141; other output errors return 1.

Waffle owns executable registration, symlink resolution and admission policy; this utility only queries that metadata. It does not prove that the candidate can compile or start. A registered program with a failing loader can still appear. Ordinary files, persisted installer markers without registration, directories, builtins, shell functions, aliases, and the shell command cache do not count.

GNU which options beyond `-a` and `--all`, alias/function input, tilde output, native Unix permission bits, and symlink executable aliases are outside this bounded contract. This is original Waffle-specific lookup code, not an upstream GNU which port.

## Source and verification

The current entry is [src/which.rs](../src/which.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/which.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
