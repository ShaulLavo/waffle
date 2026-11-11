# sleep

This source candidate calls unchanged `uu_sleep` 0.13.0 at uutils revision `07763857f6b9a547742a994b58aef0ccd036198b`. Its one-line entry retains the upstream duration parser, operand summation, diagnostics, and `std::thread::sleep`. There is no handwritten timer or host-command fallback.

## Qualified contract

The bounded corpus covers zero, decimal and exponent durations, `s`, `m`, `h`, and `d` suffixes, subnanosecond values, multiple operands, and `--`. Invalid intervals, missing operands, invalid options, and a valid long duration followed by an invalid operand must fail without waiting. Help and version remain uutils. Diagnostic wording is not GNU byte parity.

The actual Waffle test uses the caller's one runtime and existing Preview1 worker, clock, and poll transport. It checks a summed wait with a broad lower bound, interrupts finite and infinite waits, launches again after interruption, and checks child and descriptor cleanup. It checks lazy selection, one source fetch across canonical and alias paths, removal of both paths, and runtime disposal. It does not replace the guest's clock or poll imports. The Node WASI oracle is a separate transport comparison, not runtime acceptance.

Large and infinite durations are not allowed to finish in qualification. `inf` is checked only through real cancellation. Exact scheduling latency, GNU signal diagnostic text, locale-specific interval syntax, and arbitrary saturation extremes are outside this bounded claim.

## Build and verify

The source draft does not admit sleep into the published catalog by itself. The parent must apply the workspace, lock, locale, producer, catalog, package, notice, and provenance integration. Build only sleep after that integration:

```sh
node packages/coreutils/scripts/build-sleep.ts
SLEEP_VERIFY_INTEGRATION=1 node --disable-warning=ExperimentalWarning --test packages/coreutils/scripts/sleep-source.test.ts
node --disable-warning=ExperimentalWarning packages/coreutils/scripts/sleep-oracle.ts --compare packages/coreutils/dist/sleep.wasm
bun test packages/coreutils/tests/sleep-wasi.test.ts
```

The [source receipt](../provenance/sleep.source.json) pins upstream files, the retained MIT notice, and GNU sleep 9.12 bytes. The oracle checks the executable hash before executing it. All comparisons have deadlines and output caps. Canceled subprocesses are reaped and deadline timers are cleared. The existing producer verifies patched libc, applies the common optimizer and compression policy, and enforces a 256 MiB memory maximum. Run evidence must distinguish a built candidate from an admitted packaged guest.
