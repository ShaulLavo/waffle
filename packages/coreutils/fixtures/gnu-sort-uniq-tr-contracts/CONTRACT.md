# GNU sort, uniq and tr contracts

This separate additive corpus covers 28 small native invocations: 10 sort, 9 uniq and 9 tr.
GNU coreutils 9.x supplies the oracle only. The candidate executables are built from the
existing Waffle crates. The existing 33-case head, cut and wc corpus and historical
recordings remain independent.

## Reproduce

From the repository root:

```sh
cargo test --locked --offline -p waffle-coreutils --test sort_uniq_usage_contracts -p waffle-tr --test usage_contracts
bun packages/coreutils/scripts/record-gnu-sort-uniq-tr-contracts.ts --check
node packages/coreutils/scripts/record-gnu-sort-uniq-tr-contracts.ts --check
```

The existing programs CI job discovers these native Cargo integration tests without a
manifest or workflow change. Native tests consume committed expectations and need no GNU
installation. The recorder requires Linux `/usr/bin/sort`, `/usr/bin/uniq` and `/usr/bin/tr`
from GNU coreutils 9.x. `--check` compares the complete recording. `--record` creates a new
corpus exclusively and refuses to overwrite an existing file.

Set `TMPDIR` to an appropriate scratch drive on the execution host. Both runners create
private fixture directories. Rust removes its directory on success or panic, and the
recorder removes its directory in `finally`. The outer job owns cleanup after interruption.

## Byte and descriptor contract

Every candidate and oracle invocation clears the inherited environment and sets only
`LC_ALL=C` and `TZ=UTC`. Stdin, stdout and stderr are explicit pipes. A `stdin-pipe` row feeds
the recorded bytes through stdin. A `file-operand` row writes those bytes to a regular file
named `input`, passes the recorded operand, and closes an empty stdin pipe. These tests do
not qualify redirected regular-file stdin or TTY descriptors.

`corpus.tsv` records the GNU versions, environment and descriptor kinds, then one row per
invocation. Columns are case name, program, argv, input kind, input bytes, input SHA-256,
exit status, stdout and stderr. Byte columns use lowercase hexadecimal, or `-` for empty
bytes. Each UTF-8 argument is encoded separately in hexadecimal and separated by colons.
An empty argv column means no arguments. The recorder recomputes the input hashes and
compares the whole file. Native tests check exact stdout, stderr and status, unique names,
recorded hash lengths and per-program counts. Neither runner normalizes expected output.

## Coverage and limits

- Sort covers C-locale byte ordering, including NUL and invalid UTF-8 in newline records,
  numeric ordering, stable key and numeric ordering, unique and numeric-unique output,
  reverse ordering, NUL-delimited records, empty input and an unterminated file.
- Uniq covers adjacent groups, counts, nonadjacent duplicates, repeated and unique groups,
  NUL-delimited records, empty and unterminated input, and invalid UTF-8.
- Tr covers ranges, translation, deletion, squeezing, combined translation or deletion
  with squeezing, NUL translation, invalid UTF-8 passthrough, empty input and a short
  destination set on unterminated input.

All 28 invocations are successful usage cases with status zero and empty stderr. Exact
error diagnostics, other options, other locales, large-input capacity, WASI, browser and
consumer-shell behavior remain outside this corpus. Passing native tests establishes only
the stated cases and descriptor kinds.
