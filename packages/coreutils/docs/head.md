# Head utility

`head` prints the first ten lines of each input by default. It is the upstream uutils program, compiled as a separate WASI guest. `installHead` from `bash-web/utilities/head` registers it on the shell's existing Waffle runtime. The shell core does not include it.

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

## Loading

`installHead(runtime, { wasmUrl, workerUrl })` loads nothing until the first spawn. Instead of `wasmUrl`, `source` accepts a `Uint8Array` or a function returning bytes or a promise of bytes. Ordinary guests cannot accept a precompiled `WebAssembly.Module`, because Waffle needs the original bytes to add interrupt checks. See [Install utilities](guides/install-utilities.md).

## Source and build

`shell/utilities/src/bin/head.rs` calls `uucore::bin!(uu_head)`. It initializes WASI libc's working directory from Waffle's `PWD` before calling upstream. There is no local implementation of head's parsing or I/O.

`uu_head` and `uucore` are pinned to registry version `0.12.0` in `shell/utilities/Cargo.toml` and `shell/Cargo.lock`. The crate's source receipt identifies uutils/coreutils revision `dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69`, path `src/uu/head`. Both crates are MIT licensed, copyright uutils developers. `npm run notices:shell` includes their license files and transitive dependency notices in the distribution.

The direct Rustix dependency enables its `std` feature so uucore's WASI file-descriptor conversions compile. This dependency is intentionally feature-only. A new workspace utility can reuse `buildWasiShell(["-p", "shell-utilities", "--bin", "head"])` from `scripts/wasi-build.ts`, changing the binary name. The helper supplies the patched wasi-sdk 34.0 sysroot, the memory cap, and the final guest verifier. No guest-specific linker recipe is needed.

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test head` tests the native upstream binary. After `npm run build:shell`, `npm run build:utilities`, and `npm run build:node-harness`, `node --test scripts/test-own-shell-head.ts` tests the real guest through Waffle, including GNU usage controls, cancellation, and the stdin differences above.

## Recorded GNU controls

The 24 comparison scripts retain their original text. Qualification replays `scripts/owned-fixtures/head-gnu.json`, not the host's Bash or coreutils. Each recording contains raw stdout and stderr bytes in base64 and the exit status. Tests compare stdout bytes, status, and diagnostic presence. Only the documented standard-input header difference is normalized.

The recording used GNU Bash `5.3.15(1)-release`, binary SHA-256 `575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5`, and `head (GNU coreutils) 9.12`, binary SHA-256 `313bf1f0c296d63fa9534394e22a502cfe29d9fe9e110c5b45f3c070b9ddf3e1`. Each unchanged script ran twice with empty stdin, a fresh working directory, `PATH=/usr/bin:/bin`, `HOME=/home/user`, and `LC_ALL=C`. Both runs produced identical bytes and status. Recording processes had a two-second bound and owned process-group cleanup.

`node --test scripts/test-own-shell-head-oracle.ts` checks the recorded identities, original case-set digest, complete observation digest, and absence of host subprocesses in qualification. The normal scoreboard test discovery includes this check automatically. This additive recording does not change the frozen score oracle, membership, exclusions, or baselines.
