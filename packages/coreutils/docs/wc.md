# wc

`bash-web/utilities/wc` installs the `uu_wc` implementation from `uutils/coreutils` at revision `07763857f6b9a547742a994b58aef0ccd036198b`. The separately linked `wc.wasm` guest loads on first use and registers `/bin/wc` on the caller's Waffle runtime. It does not use a local counting implementation or a coreutils multicall binary.

The upstream command accepts its full option set. This change qualifies the default line, word, and byte counts, the `-l`, `-w`, and `-c` selections, file operands, standard input, pipelines, missing files, and invalid options. Tests compare exact output bytes and exit statuses. They also run cancellation, sustained-input memory, and broken-pipe cases through the real guest.

Other upstream options remain available but have no new compatibility claims in this change. WASI does not provide native host files or operating-system services beyond those exposed by Waffle.

The guest links the same patched WASI libc and 256 MiB memory cap as the other browser programs. Its upstream MIT license is retained in `shell/wc/LICENSE.uutils-coreutils` and included in the distribution notices. The artifact receipt records the `wc.wasm` SHA-256 with the other utility guests.

Waffle's interrupt instrumentation does not accept SIMD value types. The build disables `simd128` for this guest. A local patch to `bytecount` 0.6.9 makes its existing WASM module and call sites honor that target setting, so counting uses the crate's scalar implementation. The patch changes no `uu_wc` code. The vendored crate retains its MIT and Apache 2.0 licenses.

## Verification

Run `npm run build:node-harness && node --test scripts/test-own-shell-wc.ts` for Waffle process tests. Run `npx playwright test tests/external-commands.spec.ts --project=chromium --grep wc` after `npm run build:browser` for the browser cases. `npm run test:shell:wasi` checks the guest contract and prints its compressed sizes.
