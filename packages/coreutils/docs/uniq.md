# uniq

Filter adjacent equal records with the pinned uutils implementation. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/uniq` with a `/bin` alias.

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

The usage suite compares adjacent duplicate removal, `-c` counts, `-d` repeated groups, `-u` unique groups, `-i` case-insensitive matching, named relative inputs, output files, empty input, and unterminated input against GNU uniq with `LC_ALL=C`. Non-adjacent equal lines remain separate. Use `sort | uniq` to group all equal lines. Missing inputs and invalid options retain upstream diagnostics and failure statuses.

## Resource limits

The guest shares the repository's 256 MiB linear-memory cap. Upstream retains record data and may buffer an entire group for group-printing options. An unusually long record or group can exhaust memory. No fixed input-size guarantee or full locale parity is claimed. The tests cover the common C-locale behavior above through real Waffle processes, including redirected files and stdin pipelines.

## Source and verification

The current entry is [src/bin/uniq.rs](../src/bin/uniq.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/uniq.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
