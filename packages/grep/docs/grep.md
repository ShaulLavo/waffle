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

- Initializes libc working directory from `PWD` on WASI (`chdir(getenv("PWD"))`)
- Uses `read(2)` stdio buffering instead of FreeBSD-only `mmap`
- Emulates `REG_STARTEND` and NUL-safe literal scanning on musl `regex(3)`
- Reports `EISDIR` on directory operands when directory action is `read`, distinguishes `-r` from `-R` symlink following, lets a later `-H` clear `-h`, and checks `stdout` flush errors while preserving `SIGPIPE` (`141`)
