# Grep

`@waffle-os/grep` ships upstream FreeBSD `usr.bin/grep` (`2.6.0-FreeBSD`, BSD-2-Clause, pinned in `sources.lock.json`) compiled to `wasm32-wasip1` against Waffle's patched `wasi-libc` sysroot. Import `grep` (or `fastGrep` for parallel search-worker acceleration on the proven recursive `-a` subset) and pass it to Waffle's program installer.

## Supported capabilities

FreeBSD `grep` provides POSIX and GNU-compatible matching, recursion, context, and filtering:

- Pattern modes: BRE (default / `-G`), ERE (`-E`), fixed strings (`-F`), `-e PATTERN`, `-f FILE`, `-i`, `-v`, `-w`, `-x`, `-z`
- Output modes: `-n`, `-c`, `-l`, `-L`, `-o`, `-b`, `-q`, `-s`, `-H`, `-h`, `--null`, `--label`, `--color`, `-m NUM`, `-A NUM`, `-B NUM`, `-C NUM`, `--line-buffered`
- Traversal & filtering: `-r` / `--recursive` (follows explicit command-line symlinks only), `-R` / `--dereference-recursive` (follows all symlinks), `-d read|skip|recurse`, `-O` / `-p` / `-S`, `--include`, `--exclude`, `--exclude-dir`, `--include-dir`
- Binary handling: default binary detection (`Binary file ... matches`), `-a` / `--text`, `-I` / `--binary-files=without-match`
- Directories: passing a directory without `-r`, `-R`, or `-d skip` reports `Is a directory` and exits with status `2`

```sh
printf 'TODO: one\nignore\nFIXME: two\n' | grep -n -e TODO -e FIXME
grep -rn --include='*.ts' --exclude-dir=node_modules 'createRuntime' src/
grep -oE '[0-9]+' numbers.txt
grep -C 2 'error' app.log
```

## WASI adaptation

`patches/freebsd-grep-wasi.patch` keeps upstream matching and CLI parsing intact while adapting only host boundaries:

- Initializes libc working directory from Waffle's `runtime_proc.cwd` import (`PWD` is ordinary environment and does not override or break launch cwd) and defaults unset locale to `C` (matching POSIX and `fastGrep`)
- Uses `read(2)` stdio buffering instead of FreeBSD-only `mmap` and propagates mid-stream read failures separately from EOF with status `2` (while preserving `-q` match precedence)
- Emulates `REG_STARTEND` via NUL-segmented calls on musl `regex(3)` and uses NUL-safe, locale-aware UTF-8 multibyte `towupper()` case folding for literal patterns (matching GNU `grep` and `fastGrep` under both `C` and `C.UTF-8`); under `-a`, regex matches wholly before or wholly after embedded NUL bytes match, while a single regex match spanning across an embedded NUL byte does not match under musl `regex(3)`
- Reports `EISDIR` on directory operands when directory action is `read`, distinguishes `-r` from `-R` symlink following, matches `--include`/`--exclude` globs against file basenames for recursively discovered files while preserving full-path matching for explicit operands (matching GNU `grep` and `fastGrep`), short-circuits `-q` across operands/recursive traversal and `-L` on the first match in a file, lets a later `-H` clear `-h`, suppresses `-c` output when `-l`/`-L` is active (matching GNU `grep` and `fastGrep`), matches GNU `-L` exit status (`0` if any input line matched, `1` if none matched), exits `141` silently on stdout `EPIPE`, and exits `2` on non-`EPIPE` stdout errors
