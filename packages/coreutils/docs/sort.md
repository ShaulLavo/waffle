# sort

Sort records with the pinned uutils implementation. The `coreutils` ProgramPackage exports this separate lazy guest at `/usr/bin/sort` with a `/bin` alias.

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

The usage suite compares default line ordering, `-n`, `-r`, `-u`, combined `-nru`, `-c`, named relative inputs, `-o` output files, standard-input pipelines, empty input, and unterminated input against GNU sort with `LC_ALL=C`. Invalid options and missing files return upstream diagnostics and failure statuses. The upstream argument parser and sorting algorithms are unchanged.

## WASI resource limits

Sorting buffers input. Upstream's WASI implementation sorts in memory rather than spilling runs to temporary files. It uses single-threaded sorting and ignores the thread-count option. `-S` is not a hard memory budget on this target, and `-T` does not enable disk-backed sorting. The guest's linear memory has the repository's 256 MiB cap. Record data, indexes, sorting scratch, and the program itself share that memory. Inputs near that size are not guaranteed to fit. Allocation failure can terminate the guest rather than produce a GNU diagnostic.

The browser test uses Waffle's filesystem and ordinary process admission. No native subprocess, thread, external compressor, or host filesystem adapter is supplied. C-locale common cases are tested. Full locale parity, large-input capacity, and external compression are not claimed.

## Source and verification

The current entry is [src/bin/sort.rs](../src/bin/sort.rs). Prepare this family once with
`bun run --cwd packages/coreutils prepare:package`. The root `programs:integration`
command checks the actual public family exports on Waffle after the required assets exist.
Wrapped uutils guests initialize libc cwd from PWD; keep it aligned with the requested cwd
when using their relative file operands. Env's child request preserves its own cwd policy.

[The original transfer guide](../provenance/history/docs/sort.md) is frozen historical
source/qualification evidence, not current installation or build instructions. Its
recordings, license identities and observations have not been rerecorded.
