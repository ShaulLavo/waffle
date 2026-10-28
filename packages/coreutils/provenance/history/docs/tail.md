# tail

`tail` writes the last lines from standard input or one file. It is a separate WASM utility, installed with `installTail` from `bash-web/utilities/tail`.

## Supported behavior

- `tail` and `tail file` write the last 10 lines.
- `tail -n N` and `tail -nN` select the last `N` lines. Zero writes no bytes.
- `--` ends option parsing. A file named `-` selects standard input.
- Output preserves every input byte, including NUL, CRLF, and a missing final newline.
- The utility reads standard input through EOF before writing. It retains only the requested number of complete records and the current partial record, up to 16 MiB in total. Exceeding that bound returns status 1 with a diagnostic.
- Invalid options, counts, and extra file operands return status 2. An input open or read failure returns status 1 and writes a diagnostic to standard error.

## Left out

Multiple input files, filename headers, `-c`, `-f`, and other GNU `tail` options are not supported.

## Verification

The native and WASI streaming tests check exact output bytes, line counts, pipeline EOF, cancellation, and error statuses. The Chromium acceptance test runs `seq` and `tail` as separate Waffle guests in a 20,000-line pipeline. These checks assert the utility contract directly because `tail` is an external program, not a GNU Bash builtin.
