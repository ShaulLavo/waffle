# Curl test prerequisites

The shell deadline and abort controls live in `tests/native-command.test.ts`.
They use ordinary host commands, not the curl oracle or its cache. On Linux,
run the deadline control from the repository root without `NATIVE_CURL`:

```sh
bun test packages/curl/tests/native-command.test.ts \
  --test-name-pattern '^deadline stops the shell and its child, not just the parent$'
```

The test keeps its 100 ms deadline and checks each recorded process immediately
when the command rejects. Only an absent process or a zombie passes. Set `TMPDIR`
to a task-owned scratch directory to choose where these controls create files.

`tests/native-command-discovery.test.ts` checks that the generic controls run
without oracle setup and that both genuine oracle suites still reject missing
`NATIVE_CURL`. It does not rerun the deadline control.

The complete `bun run --cwd packages/curl test` command still discovers both
oracle suites. It requires the host-matching HTTP-only curl 8.23.0 binary and
receipt produced by `scripts/native-oracle.ts`, plus `CURL_NATIVE_SCRATCH_ROOT`.
Provision them with the existing recipe:

```sh
NATIVE_CURL_CACHE=/absolute/cache CURL_NATIVE_SCRATCH_ROOT=/absolute/scratch \
  bun packages/curl/scripts/native-oracle.ts provision
```

Set `NATIVE_CURL` to the returned `path` before running the complete suite. The
recipe retains its source, compiler, receipt, executable digest, and HTTP-only
version checks. A system curl binary is not a substitute.
