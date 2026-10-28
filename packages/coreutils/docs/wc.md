# wc

Count lines, words and bytes with the pinned uutils implementation. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/wc` with a `/bin` alias.

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

The upstream command accepts its full option set. This change qualifies the default line, word, and byte counts, the `-l`, `-w`, and `-c` selections, file operands, standard input, pipelines, missing files, and invalid options. Tests compare exact output bytes and exit statuses. They also run cancellation, sustained-input memory, and broken-pipe cases through the real guest.

Other upstream options remain available but have no new compatibility claims in this change. WASI does not provide native host files or operating-system services beyond those exposed by Waffle.

The guest links the same patched WASI libc and 256 MiB memory cap as the other browser programs. Its upstream MIT license is retained in `shell/wc/LICENSE.uutils-coreutils` and included in the distribution notices. The artifact receipt records the `wc.wasm` SHA-256 with the other utility guests.

Waffle's interrupt instrumentation does not accept SIMD value types. The build disables `simd128` for this guest. A local patch to `bytecount` 0.6.9 makes its existing WASM module and call sites honor that target setting, so counting uses the crate's scalar implementation. The patch changes no `uu_wc` code. The vendored crate retains its MIT and Apache 2.0 licenses.

## Source and verification

The current entry is [crates/wc/src/bin/wc.rs](../crates/wc/src/bin/wc.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/wc.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
