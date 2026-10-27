# which

`which [-a|--all] [--] name...` finds registered Waffle programs without running them. Import `installWhich` from `bash-web/utilities/which` and install it on the runtime passed to `createShell`. It loads `dist/which.wasm` on its first spawn, using ordinary WASI admission and raw source bytes. Installation does not fetch or compile it.

## Supported

- Search exported `PATH` entries in order. Print the first match, or every matching entry with `-a` or `--all`. Repeated PATH entries produce repeated results in all-match mode.
- An empty PATH entry means the current directory. Relative entries resolve from the process cwd. An unset PATH searches nowhere. An empty PATH searches only cwd.
- Names containing `/` bypass PATH and query that path directly.
- Print normalized absolute paths, one per line. The host walks the original path before normalization, so a non-directory component cannot disappear through `..`.
- Process every name. Return 0 when every name matches, 1 if any name is missing, and 2 for usage or host-query errors. Missing names produce no diagnostic. Waffle owns cancellation and its signal-derived status. A broken output pipe returns 141; other output errors return 1.

This command answers whether a live regular file has an exact Waffle executable registration. It does not prove that the candidate can compile or start. A registered program with a failing loader can still appear. Ordinary files, persisted installer markers without registration, directories, builtins, shell functions, aliases, and the shell command cache do not count.

GNU which options beyond `-a` and `--all`, alias/function input, tilde output, native Unix permission bits, and symlink executable aliases are outside this bounded contract. This is original Waffle-specific lookup code, not an upstream GNU which port.

## Needs from other tracks

The existing Waffle pin `c1cb67c300439af24335d0b2ec481bfb52f79a01` has the metadata query, but its ordinary instrumenter rejects guests that directly import `runtime_proc` with `Cannot instrument WebAssembly: reserved import namespace runtime_proc`.

bash-web therefore defines the lookup-only `bash_web_executable` namespace. The shared shell worker supplies its four functions using Waffle's supported `WorkerExecutor.namespaces` and `imports` hooks. An import-only declaration module asks the public `Wasi.imports` resolver for Waffle's existing guarded process functions. It has no memory, exports, or executable code. Each alias forwards arguments and results unchanged. It does not replace Waffle's process ABI or change admission. `installWhich` still registers raw source with `execution: "wasi"`, with ordinary interruption instrumentation enabled.

Other hosts running this guest must provide this exact namespace with the following Waffle process semantics:

- `bash_web_executable.access_start(path_ptr, path_len, cwd_ptr, cwd_len, 1)` submits an executable query scoped to the caller PID. The path is UTF-8 and may be relative; cwd is absolute. It returns a request ID or a negative WASI errno.
- `access_take(id)` returns 0 for live regular-file metadata plus exact registry membership, `-6` while pending, or a negative WASI errno. `-2`, `-44`, and `-54` mean denied, absent, or a non-directory ancestor and count as a miss. Other errors remain errors, including unavailable host support.
- `poll` subscription kind 5 waits for query readiness. `access_cancel(id)` retires an abandoned query. The guest waits on one query at a time and its drop guard cancels an abandoned query after a poll failure. Waffle's ordinary instrumentation owns fatal interruption and caller-exit cleanup, and must prevent late responses from reviving retired requests.
- Queries must use the same filesystem identity, cwd resolution, and registry admission checks as spawn. They must not fetch source, compile a module, launch a worker, allocate child descriptors, or execute a candidate. A filesystem marker or Preview1 `X_OK` alone is not this contract.

No pin change or provider weakening is needed for the bash-web worker. A standalone Waffle host without that worker must supply the alias or add supported direct query imports to ordinary admission before it can run this guest. No spawn-and-wait probe is used or requested for `which`. Such a probe could run arbitrary command side effects. Waffle should preserve this metadata-only contract if its process implementation changes. A future symlink-alias policy belongs in Waffle's shared executable admission, not in this utility.

## Verification

`cargo test --locked --manifest-path shell/Cargo.toml -p shell-utilities --test which -j2` checks explicit expected results and injected query failures. `node --test scripts/test-own-shell-which.ts` exercises the compiled ordinary WASI guest through the pinned Waffle worker/process stack, including unregistration, stale markers, lazy loading, and physical worker cleanup. Build the `which` and `shell-runtime` guests and Node worker bundle first using the repository build helpers.

The expectations are this documented registered-program contract. Tests do not call a live host which or Bash and make no GNU byte-for-byte compatibility claim. The Node worker tests do not claim a browser UI campaign.
