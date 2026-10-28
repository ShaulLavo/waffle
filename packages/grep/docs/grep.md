# Grep

`grep` streams matching records from standard input or files as a cooperative WASI program. Import `grep` from `waffle-grep` and pass it to `installPrograms` from `waffle/programs` with the caller's generic launcher. Waffle owns lazy loading, registration and disposal.

Supported options are `-n`, `-i`, `-v`, `-F`, `-E`, `-c`, `-q`, `-H` and `-h`. Options can be grouped, and `--` ends option parsing. The last `-H` or `-h` wins.

```sh
printf 'TODO: one\nignore\nFIXME: two\n' | grep -n -e TODO -e FIXME
grep -Hin -F -e 'a+b' first.txt
grep -h -E -e '^warning:' -e '^error:' first.txt second.txt
```

`-e` can repeat or attach to a group. Newlines within a pattern separate alternatives. Without `-e`, the first ordinary operand is the pattern. No file operands means standard input, and `-` explicitly reads it. Multiple operands normally print filename prefixes. Forced stdin prefixes use `(standard input)`. Counts are per operand, and selected final unterminated records gain a newline.

Status is 0 for a selected record, 1 for no selected records, and 2 for an option, pattern, file, read or output error. Quiet success takes priority over earlier file errors. Cancellation and broken pipes retain statuses 130 and 141.

The matcher uses Rust `regex` 1.13.1 from the frozen lock. The Bashkit-derived selection and original streaming descriptor adapter remain. Limits are 4096 pattern bytes including separators, a 256 KiB regex program/cache, nesting 64, and records at most the smaller of the configured line limit and 64 KiB.

Recursive traversal, `-f`, long options, context, PCRE, backreferences and complete GNU locale/BRE/ERE parity are excluded. Input records preserve CR, NUL and invalid UTF-8 instead of GNU binary-file classification.
