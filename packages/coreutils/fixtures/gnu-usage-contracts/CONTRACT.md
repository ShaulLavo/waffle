# GNU usage contracts

This additive corpus covers 33 uses of documented head, cut and wc options on small byte
fixtures. It does not replace any historical recording.

The native Rust integration tests invoke each package's actual executable. GNU coreutils
9.x supplies the recorded oracle only. This corpus does not establish WASI, browser,
consumer-shell, locale-dependent multibyte or TTY behavior.

## Reproduce

Run the existing native Cargo command from the repository root, or just this slice:

```sh
cargo test --locked -p waffle-coreutils --test head_usage_contracts -p waffle-cut -p waffle-wc --test usage_contracts
```

The programs CI job already discovers these tests. They require no host GNU installation.
Each test clears the inherited environment, sets `LC_ALL=C` and `TZ=UTC`, and uses a private
temporary directory that is removed on success or panic. Set `TMPDIR` to the appropriate
scratch drive on the execution host. The outer job owns cleanup after interruption.

To compare the recording with GNU coreutils 9.x on Linux:

```sh
bun packages/coreutils/scripts/record-gnu-usage-contracts.ts --check
```

The recorder invokes `/usr/bin/head`, `/usr/bin/cut` and `/usr/bin/wc` directly. Its only
environment variables are `LC_ALL=C` and `TZ=UTC`. Every command uses the embedded input
bytes, either through an explicit stdin pipe or a task-created file named `input`. Using
an explicit pipe matters for `wc` because GNU uses descriptor metadata to choose padding.
The recorder works under both Bun and Node without relying on synchronous buffer-input behavior.
Its temporary directory is removed in `finally`. `--record` creates a new corpus exclusively and refuses to overwrite
an existing one. Neither mode modifies historical recordings.

## Format and coverage

`corpus.tsv` records the GNU versions and environment, then one row per invocation. Columns
are name, program, argv, input mode, input bytes, input SHA-256, exit status, stdout and stderr.
Byte columns use lowercase hexadecimal or `-` for an empty byte sequence, so rows have no
trailing tabs. Argv encodes each UTF-8 argument separately in
hexadecimal, separated by colons. An empty argv column means no arguments. The recorder's
`--check` recomputes the hashes and compares the entire file. Native tests check exact stdout,
stderr and status, unique names and per-command case counts.

- Head has 12 cases for empty and unterminated input, CRLF, binary bytes, zero and negative
  counts, negative zero, NUL records, a split UTF-8 sequence and the obsolete count form.
- Cut has 12 cases for empty and unterminated input, CRLF, invalid UTF-8 in the C locale,
  overlapping and open ranges, complements, tabs, empty fields, undelimited suppression,
  custom and empty output delimiters, and NUL records.
- Wc has 9 cases for empty and unterminated input, CRLF, NUL, invalid UTF-8, ASCII whitespace,
  line boundaries, byte counts and combined flag order. Only default counts and `-l`, `-w`
  and `-c` are qualified here.

All 33 invocations are successful usage cases. Error wording, file errors and other flags
remain outside this slice. Head's documented WASI stdin read-ahead and header differences
also remain outside it. GNU is the recording oracle, never the product implementation.
