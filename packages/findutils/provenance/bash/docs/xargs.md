# Xargs utility

`installXargs` from `bash-web/utilities/xargs` installs a separate, lazy WASI guest at `/bin/xargs` on the caller's Waffle runtime. This first contract parses input and echoes batches. It does not execute commands.

```ts
import { installXargs } from "bash-web/utilities/xargs";
const xargs = await installXargs(runtime);
// Shell example: printf 'one two three' | xargs -n2
// Prints "one two\nthree\n".
// Once its processes have stopped:
await xargs.dispose();
```

## Supported contract

- No command operand selects upstream's internal echo. It joins each batch with spaces and appends a newline. It does not parse echo options in the input.
- Default whitespace splitting, single and double quotes, and backslash escapes use the upstream reader. `-0` and `-d BYTE` select literal delimiters. `-n`, `-L`, `-s`, `-x`, `-r`, `-E`, and `-a FILE` use upstream parsing and batching. Attached and long option forms remain upstream behavior.
- Empty input prints a newline unless `-r` is supplied. `-a` reads a file relative to the guest's `PWD`; otherwise input comes from fd 0. `--` ends options, not the command restriction.
- `--help` describes this restriction. `--version` reports the upstream module version, 0.11.0. Invalid arguments and malformed quotes return status 1 with a diagnostic.
- Registration does not load bytes or start a worker. First spawn loads `dist/xargs.wasm` through ordinary WASI admission. `WasiUtilityOptions` accepts `wasmUrl` or raw `source` bytes, never a precompiled module. Waffle adds interruption checks and owns guest termination.

## Explicit command execution is gated

Every command operand, including `echo`, `/bin/echo`, and commands combined with `-r`, fails with status 1 and a `runtime_proc.spawn/wait` diagnostic. The gate runs after upstream option parsing but before opening the input file or reading stdin. `-P` is rejected rather than accepting upstream's unimplemented parallelism. `-I` and `--replace` are rejected because this contract has no command arguments to replace.

Stock Rust `std::process::Command` does not call Waffle's process ABI on WASI. Supporting explicit commands needs a bridge to the pinned runtime's `runtime_proc.spawn` and `wait`, preserving argv, cwd, environment, inherited descriptors, child status mapping, cancellation, and child-handle cleanup. Waffle already exports that ABI; this utility does not yet use it. No runtime pin, admission rule, or cooperative bypass changes here. Exit codes 123 through 127 for child outcomes are not part of this first contract.

## Limits and upstream differences

This is not full GNU xargs parity. Input is decoded with UTF-8 replacement, not preserved as arbitrary bytes. Upstream skips empty delimiter records and loses a final empty quoted item without a following delimiter. These cases are not GNU compatibility claims. Diagnostics and verbose `-t` output are upstream text.

On WASI upstream uses a 4096-byte command-size ceiling, including the synthetic `echo` name and argument terminators. A larger `-s` cannot raise this system ceiling. Input is read incrementally, but a single item is collected before the size check; the guest's 256 MiB memory cap, not the batch limit, bounds that allocation. The source has no new streaming or memory guarantees.

## Source and verification

The parser, readers, batching, echo, and unit tests come from MIT-licensed `uutils/findutils` revision `505421d4e03586efeb7b9c55adf057599e192e0a`, `src/xargs/mod.rs`. `third-party/uutils-xargs/provenance.json` records the exact source and license digests. `wasi.patch` records only the command/mode gates and help text. The narrow crate manifest omits unrelated find/locate dependencies. Existing dependency versions stay locked.

`node --test scripts/test-xargs-source.ts` verifies the copied source, reverses the patch to its recorded upstream digest, and rejects changed or added source files. The standard build checks the receipt before compiling. Distribution notices include the retained upstream license.

Focused native controls run with `cargo test --locked --manifest-path shell/Cargo.toml -p shell-xargs --test contract`. Build the guest with `buildWasiShell(["-p", "shell-xargs", "--bin", "xargs"])` from `scripts/wasi-build.ts`. After building `shell-runtime` and the Node harness, `node --test scripts/test-own-shell-xargs.ts` exercises the real guest through Waffle with pipelines, input files, gates, lazy loading, disposal, and worker cleanup. These are literal acceptance controls, not GNU recordings. They run no live host oracle. Browser qualification and GNU comparison remain work for the programs plan, not claims made by these tests.
