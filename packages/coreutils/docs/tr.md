# tr

Translate, delete and squeeze bytes. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/tr` with a `/bin` alias.

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

## Source and supported behavior

The program calls unmodified upstream `uu_tr` and `uucore` from uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, version `0.13.0`. `crates/tr/Cargo.toml` and the Cargo lock record the source. The [MIT license](licenses/uutils-coreutils-MIT.txt) is included in distribution notices. Translation and squeezing run inside the guest; there is no host program fallback.

The frozen GNU cases cover character ranges and classes, translation, deletion, squeezing, combined operations, complements, short and repeated destination sets, truncation, empty and unterminated input, binary bytes, errors, and composition with cut. Comparisons use `LC_ALL=C`, stdout bytes, exit status and stderr presence. They do not establish locale-dependent multibyte behavior or exact diagnostic wording.

## Source and verification

The current entry is [crates/tr/src/main.rs](../crates/tr/src/main.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/tr.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
