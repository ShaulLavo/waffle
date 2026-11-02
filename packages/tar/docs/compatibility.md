# Tar compatibility

This package compiles uutils tar at `dffa9350f78b3bfbc9b4fc70a0f0205a53a937b6`.
The archive reader/writer is tar-rs 0.4.46. Gzip is flate2 1.1.10 with its pure
Rust backend. The command is not a TypeScript archive evaluator and never runs
a shell, compression helper, native executable, network client or another guest.

## Qualified scope

- List regular files, directories and multiple entries with `-t`, `-f` and `-v`.
- Use an archive file or `-f -` for an inherited stdin pipe.
- Read gzip explicitly with `-z` or automatically by its magic bytes. The reader
  consumes compression trailers and reports checksum failures.
- Use one `-C` to change the directory for file operands. The archive path stays
  relative to the original process cwd. Repeated position-sensitive `-C` is not
  supported by upstream clap and is an error.
- Old `tf archive.tar` keystrings are upstream behavior.
- Unknown flags, missing archives, bad headers, unsupported zstd, xz helpers and
  member selection return nonzero rather than successful partial operations.

Verbose output follows uutils, not GNU's exact spacing or numeric-owner fallback.
The deterministic corpus fixes `TZ=UTC`. No arbitrary local-timezone parity is
claimed. tar-rs accepts POSIX/ustar, GNU and PAX archive structures; exhaustive
archive-format parity is not claimed.

## Create and extract are blocked on WASI

The native build proves upstream can create and extract files and directories,
plain or gzip, and read their contents back. That is not WASI qualification.
The WASI command returns status 2 for both operations before opening an output
archive or extracting any entry. The error names the missing metadata capability.
It does not leave empty success files or silently discard archive metadata.

At accepted Waffle main, `runtime_fs.path_permissions_get` reports only partial
single-principal mode bits. There is no guest permission setter and no host
UID/GID contract. tar-rs' wasm32 metadata writer is `unimplemented!()`; its
permission restorer returns `Not implemented`. Treating these as zero ownership,
empty mode, successful chmod, or ignored errors would fabricate behavior.

This package therefore does not create special devices, FIFOs, sockets or host
ownership, even when the process is asked to extract such an entry. Preservation
flags, xattrs, ACLs, external compression and privileged native operations are
not supported. The native oracle touches only run-owned fixtures and uses no
privileged archive entries. WASI extraction controls use a fresh virtual
filesystem, preserve an unrelated sentinel and assert no extracted files exist.

The parent owns the runtime metadata contract. Until that prerequisite is
published and read/write guest cases pass, do not advertise this package as a
replacement for ordinary create/extract workflows or add it to default catalogs.
