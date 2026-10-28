# Xargs execution

Xargs runs explicit commands through Waffle's existing `waffle-process-consumer`
crate. The runtime receives an argv array, the caller's environment and current
working directory, and the complete inherited descriptor list. No shell parses
command strings. With no command operand, xargs retains its print-only echo.

## Executables

A command needs a live filesystem path and executable registration on the caller's
runtime. PATH lookup uses the caller's PATH, or `/bin:/usr/bin` when absent. Empty
components mean cwd; commands containing a slash bypass PATH. The runtime checks
access without loading a module, then checks the live registration again at spawn.
The current coreutils inventory has no external echo executable. `xargs echo`
returns 127 until a real utility is installed; it cannot call a Bash builtin.

## Input and child results

Upstream quoting, whitespace, `-0`, `-d`, `-n`, `-L`, `-s`, `-E`, and `-r` control
argument parsing and batching. Consecutive byte delimiters preserve empty items.
Stdin-driven batches give each child an owned EOF pipe instead of the input stream.
With `-a`, children inherit stdin. Extra descriptors retain their original numbers,
including sparse bindings; libc preopens remain separate. Cwd comes from the runtime
process identity, independently of `PWD`.

A successful child gives status 0; any ordinary nonzero child exit gives 123. Exit
255 stops further batches with 124, a child signal gives 125, failure to execute
gives 126, and a missing executable gives 127. Real child exits 126 and 127 give 123. A fatal caller signal retains the runtime's signal outcome and cancels the
owned child job. The shared consumer waits for descriptor/filesystem safety and
physical worker retirement and owns cancellation cleanup; xargs copies none of
that process state machine.

Replacement (`-I`, `--replace`) and every `-P` form remain rejected before input
access. Native execution exists for controlled tests; shipping WASI execution
has no native or shell fallback. Waffle process requests require UTF-8 strings;
xargs retains the upstream reader's UTF-8 conversion behavior.

## Verification

`bun run --cwd packages/findutils test:xargs:ci` checks source reversal and drift,
build routing, the native GNU oracle comparison, the xargs-only WASI build, and
actual process-ABI execution on the singular generic Waffle worker. It requires
the pinned Rust toolchain, C compiler, wasi-sdk 34.0, shared patched sysroot, Bun
workspace dependencies and prepared runtime modules. The test utility is an
original controlled fixture, compiled temporarily and never installed as a product.
The shared family harness owns its controller's independent launch-job metadata
until runtime disposal; assertions separately require no surviving xargs-owned
jobs, child PIDs or leaked parent descriptors.

The qualification command does not rebuild find, another program family, the
runtime network module or the SDK. The reusable `findutils-xargs.yml` workflow restores the shared network artifact,
caches the pinned SDK and patched libc, and runs the WASI/type checks. Root CI
calls it after the network producer; native/source/route checks stay in the
existing programs job, without duplicate execution. Historical Bash receipts and oracle fixtures
under `provenance/bash` stay unchanged.
