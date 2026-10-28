# cut

Select byte, character and field ranges. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/cut` with a `/bin` alias.

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

## Supported boundary

The implementation is upstream `uu_cut` and `uucore` at uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, version `0.13.0`. Cargo locks both the revision and transitive dependencies. `crates/cut/src/main.rs` calls upstream's entry after setting the WASI working directory from `PWD`. No selection algorithm is copied or replaced.

The GNU comparison cases cover byte and character ranges in `LC_ALL=C`, open and overlapping ranges, complements, tab and custom field delimiters, output delimiters, undelimited suppression, empty fields, files and stdin, relative paths, empty and unterminated input, NUL and binary bytes, invalid options, and exit status. Error text is upstream's and need not match GNU's wording.

WASI exposes the runtime's filesystem, not the host filesystem. These tests do not establish full GNU parity, locale-dependent multibyte behavior, or performance parity.

## Source and verification

The current entry is [crates/cut/src/main.rs](../crates/cut/src/main.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/cut.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
