# nl

Add line numbers to byte-oriented text. The coreutils family builds `nl` as a separate WASI guest, with `/usr/bin/nl` and `/bin/nl` program paths.

```sh
nl -ba -v42 source.txt
nl -b 'p^[[:digit:]]' -w4 -nrz -s ': ' source.txt
```

## Supported behavior

`-ba` numbers every line. `-b a`, `-b t`, and `-b n` number all, nonempty, or no lines. The default is `t`. Whitespace-only lines are nonempty.

`-v` chooses the starting number. `-i` sets the increment. `-w` sets the minimum width, `-n` selects `ln`, `rn`, or `rz` formatting, and `-s` sets the separator. Their long options are also supported. Numbers continue across operands. Section delimiters, header and footer styles, `-l` blank-line groups, and `-p` page numbering use the upstream implementation.

No operands reads standard input. A `-` operand also reads standard input. `--` ends option parsing. Missing files report an error and do not prevent later files from being read. Invalid options and failed reads or writes return nonzero status.

Input bytes, CRLF, NUL, and invalid UTF-8 are retained. As in GNU `nl`, an unterminated final line gains a newline. The WASI entry sets libc's working directory from `PWD`, so the caller must keep `PWD` aligned with its requested cwd.

## Regular expressions and differences

`pBRE` numbers matching lines. The original adapter translates common basic regular expressions into upstream's byte-regex grammar. It covers character classes, anchors, literal unescaped `()+?|{}`, and escaped grouping, alternation, repetition, and intervals. Backreferences are explicitly rejected with status 1. This is not full GNU BRE parity. Matching is byte-oriented, not locale-sensitive.

The command keeps uutils help, version, and diagnostic wording. The oracle compares successful stdout bytes and exit status, plus diagnostic presence rather than GNU's exact messages. There is no native-command fallback.

## Source and verification

The implementation is unmodified uutils `uu_nl` 0.13.0 at revision `07763857f6b9a547742a994b58aef0ccd036198b`. [The source receipt](../provenance/nl.source.json) records hashes and the original entry/BRE adapter. The family notices generator includes `uu_nl` and its production dependency licenses. The guest uses the existing 256 MiB WASI cap and interrupt rewriting, not cooperative execution.

Build and compare the actual stripped guest with the same inputs sent to GNU `nl`:

```sh
node packages/coreutils/scripts/build-nl.ts
node --test packages/coreutils/scripts/nl-source.test.ts
NL_SCRATCH_ROOT=/verified/scratch node --disable-warning=ExperimentalWarning \
  packages/coreutils/scripts/nl-oracle.ts --compare "$PWD/packages/coreutils/dist/nl.wasm"
```

Set `GNU_NL` to another GNU `nl` executable if `/usr/bin/nl` is not GNU. The TypeScript fixture is [nl-cases.ts](../fixtures/nl-cases.ts). The comparison removes its temporary files in `finally`; it reports every case and the exact guest hash. Run substantial builds and suites through your host's job runner.
