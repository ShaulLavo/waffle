# External echo

Coreutils installs the real echo guest lazily at `/usr/bin/echo` and `/bin/echo`.
The base source inventory contains 24 programs and 48 executable paths. Xargs finds
echo through the existing runtime registry and PATH lookup. No Bash builtin,
xargs special case or native host program supplies output.

The isolated `crates/echo` package calls unmodified `uu_echo` and `uucore` at
uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b`, the existing
cut/tr pin. Flags, escapes, Unicode and output formatting remain upstream. The
MIT license and exact source hashes are in `provenance/echo.source.json`.

## Output errors

Rust's standard stdout suppresses EBADF, which would make a required write to a
closed stdout silently succeed. The WASI entry uses the existing `uucore::bin_inner`
post-hook and an echo-only linker observation of `__wasi_fd_write`. It records an
actual failed nonempty stdout write, preserves the original syscall result and
reports failure after upstream completes and flushes. It never reads arguments.
Zero-output `echo -n`, `echo -n ''`, and `echo -e '\c'` still succeed with fd1 closed;
newline/default output, `echo -n x`, and `echo -e 'prefix\c'` fail.

Native GNU tests cover normal/POSIX flags, escapes, empty arguments, Unicode,
control bytes and `/dev/full`. Linux native upstream echo still suppresses the
closed-fd required-write errors; this limitation is recorded separately instead
of claiming full native error parity. The WASI controls exercise the real guest.

## Build and qualification

`bun run --cwd packages/coreutils build:echo` builds and verifies only echo with
the singular WASI helper, SDK34, patched libc and 256MiB memory maximum. The normal
family build invokes echo separately before the existing build route. Historical
transfer maps, existing old program sources and frozen oracle files stay intact.
Root Cargo files changed, so old producer input digests are not unchanged. The
selected old coreutils feature tree is equivalent; old compiled bytes retain
original receipts and are not rebuilt or relabelled here.

`test:echo:wasi` runs the actual generic process session. Before installation,
`X\n | xargs echo` fails127; after installing the real echo marker it prints `X\n`
and exits0. Cases cover direct flags/bytes, the six closed-stdout controls, exact
xargs arguments/grouping and cancellation of an open-input pipeline after real
echo output, followed by child/job/descriptor cleanup.

Hosted CI consumes only the same run's xargs artifact, checks the source/run/input
and guest checksums, builds echo once and records the qualified pair. It never
rebuilds xargs or the runtime network in the echo consumer. The existing native
programs job tests echo once. Echo-only changes still select the cached xargs
producer; unchanged inputs permit a Cargo no-op and re-export without repeating
the xargs process suite. Missing or mismatched artifacts fail the check.

A local development smoke check can explicitly use the retained PR194 candidate
and its original identity record. It cannot run that path in hosted CI or create
a source-promotion receipt. Only the final hosted source/guest pair is eligible
for parent-coordinated family publication. Released programs002/003/004 remain
immutable.
