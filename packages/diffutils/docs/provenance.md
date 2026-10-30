# Source provenance

The package builds GNU diffutils 3.12 from the official release archive at `https://ftp.gnu.org/gnu/diffutils/diffutils-3.12.tar.xz`. The source lock pins SHA-256 `7c8b7f9fc8609141fdea9cece85249d308624391ff61dedaf528fcb337727dfd`. GNU diffutils is licensed under GPL-3.0-or-later. `LICENSE.gnu` contains the upstream license and the prepared notices repeat the source identity and license.

GNU diffutils was selected because it implements the actual workflows agents already use. The command survey recorded 1,074 `diff` uses in 468 sessions and 927 `cmp` uses in 437 sessions. The maintained uutils Rust alternative was inspected at v0.6.0, commit `815ed7d8de89a236e5f636749f80a5b061017521`. Its argument parser and file driver lacked the required recursive, new-file, and whitespace modes, so using it would have meant writing those parts locally.

`patches/gnu-wasi.patch` is the only change to upstream source. It provides explicit WASI behavior for unsupported process creation, signal handling, timezone refresh, descriptor limits, and setjmp-based locale recovery. The diff algorithms, output formatters, option parsing, directory traversal, and byte comparison code remain GNU's implementation.

The TypeScript build, packaging, test, and catalog files are original Waffle adapters. They are licensed under the package MIT license. The build disables NLS, optimizes for size with `-Oz`, caps guest memory at 256 MiB, removes Wasm name sections, and emits Brotli quality 11 artifacts. It builds only the `diff` and `cmp` targets.
