# tee

The isolated tee guest calls unchanged `uu_tee` 0.13.0 at revision `07763857f6b9a547742a994b58aef0ccd036198b`. Its original entry initializes WASI cwd from `PWD` through the existing family helper. If stdout starts closed, the adapter holds a real read-only cwd descriptor in fd1 until upstream returns. This prevents an output-file open from reusing fd1 and silently receiving a second copy through stdout. Writes to that directory fail through the normal filesystem path. No syscall result or permission bit is fabricated. The source receipt records upstream hashes and the retained MIT notice.

Tee copies stdin to stdout and each file operand. It truncates files by default, appends with `-a` or `--append`, and accepts multiple outputs. Upstream reads a 32 KiB slice and writes it to all outputs before the next read. It does not collect the full input. A literal `-` operand names a file, not stdout.

Missing parents, directories, denied owner-mode writes, closed stdout, and broken output pipes use actual filesystem and descriptor errors. The tests compare GNU status, stdout bytes, output files, and diagnostic presence. Diagnostic wording, help, and version remain uutils text. `--output-error=warn`, `warn-nopipe`, and `exit` keep upstream behavior. On a stdout write failure in `exit` mode, pinned upstream still writes the current read slice to later outputs before returning failure. GNU exits before those later writes. The test records that difference explicitly rather than claiming GNU file-byte parity for this mode.

## Target limits

WASI does not install upstream Unix signal handlers. `-i` parses but does not override Waffle supervisor cancellation. SIGINT cancels the process with status 130, including blocked reads and output backpressure. GNU SIGPIPE status parity is not claimed. The Linux splice optimization does not compile on WASI.

The runtime enforces its supported owner-mode bits for one virtual principal. Unix users, groups, ACLs, device files, and `/dev/full` are outside this leaf's claim. No ownership or device behavior is fabricated.

## Qualification

Shared Cargo, locale, package, and provenance-ledger integration rows must be applied before these commands work. This source draft deliberately leaves those shared files unchanged.

```sh
node packages/coreutils/scripts/build-tee.ts
TEE_SCRATCH_ROOT=/work/tmp node --test packages/coreutils/scripts/tee-source.test.ts
TEE_SCRATCH_ROOT=/work/tmp bun test packages/coreutils/tests/tee-wasi.test.ts
```

The build uses the existing checked wasi-sdk 34.0 and patched libc route, a 256 MiB memory cap, the pinned optimizer, English-only catalogs, name stripping, and compressed-byte readback. The native oracle verifies the exact GNU tee 9.12 version and SHA-256 before each comparison. Every native subprocess has a deadline, and each owned fixture directory is removed in `finally`.

The runtime test uses the real lazy package selection and generic process supervisor. Canonical and alias paths share one source fetch. It checks output before stdin EOF, file readback, append, multiple outputs, real denied modes, closed descriptors, broken pipes, bounded cancellation, descriptor and job cleanup, handle removal, and runtime disposal.
