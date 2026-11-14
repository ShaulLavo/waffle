# Run the Runtime thread fixture

The Runtime runner executes nine cases through the page's single `createRuntime()` instance.
`pair`, `repeat` and `nested` use the verified Rust producer. The generated `join`, `child-exit`,
`kill-start`, `cpu`, `wait32` and `wait64` cases exercise process outcomes and teardown.

Prepare the package normally, then build one external fixture for all browser consumers:

```sh
bun install --frozen-lockfile
bun run prepare:package
RUSTUP_HOME=/work/cache/rustup THREAD_FIXTURE_DIR=/absolute/fixture \
  bun packages/waffle/scripts/build-thread-fixture.ts
THREAD_FIXTURE_DIR=/absolute/fixture PROCESS_SCRATCH_ROOT=/absolute/scratch \
  bun packages/waffle/tests/threads-runtime-browser-runner.ts chromium firefox webkit
```

The producer requires its pinned Rust toolchain and `wasm32-wasip1-threads` target. Consumers
verify the existing receipt and artifact without invoking a compiler. Engine arguments alone
run all nine cases. Add `--case pair` to select one case. Each case gets a fresh document.

Stock cases assert exact output, initial 17 pages, source maximum 16,384 pages, and actual
maximum 512 pages. Observed concurrent aliases share one 33,554,432-byte backing identity.
All cases require a passed filesystem fence, retired aliases and continuations, and matching
Worker stop counts. Consumed controls remain separate debt. The kill cases preserve the real
filesystem section barrier, and every case checks an ordinary sibling's real filesystem I/O.
The observer retains the original native memory object until its retirement snapshot, then
drops that reference during teardown. It creates no second memory or byte copy. These checks
establish aggregate retirement, not immediate backing or RSS reclamation.

## Run native Safari separately

The iOS entry uses the maintained page-runner host and Safari driver. It requires macOS and
an exact simulator UUID, validates iOS Simulator capabilities, and runs the complete inventory.
It owns the session, loopback server, fresh documents and scratch cleanup. Reserve the native
host using its existing coordination workflow before execution.

```sh
IOS_UDID=<exact-simulator-uuid> THREAD_FIXTURE_DIR=/absolute/fixture \
PROCESS_SCRATCH_ROOT=/absolute/scratch \
  bun packages/waffle/tests/threads-runtime-browser-runner.ts ios-safari \
  --result /absolute/ios-result.json
```

For a compiler-free native handoff, prepare one packet from the current checkout and verified
producer receipt:

```sh
THREAD_FIXTURE_DIR=/absolute/fixture \
  bun packages/waffle/tests/threads-runtime-browser-runner.ts --prepare /absolute/packet
```

The packet records the checkout commit, entry-source hashes, verified producer artifact and
receipt hashes, and complete generated asset hashes. Both runners bind that identity when
bundled and validate packet bytes before starting native resources. No historical production
commit or fixture digest is hardcoded in source. The source hashes describe the actual entries
used for the bundles, including local harness edits if preparation precedes their commit.

Transfer the packet to the reserved Mac. Run iOS Simulator Safari with the existing host:

```sh
IOS_UDID=<exact-simulator-uuid> PROCESS_SCRATCH_ROOT=/absolute/scratch \
  bun /absolute/packet/ios-runner.mjs /absolute/packet --result /absolute/ios-result.json
```

Actual desktop Safari retains its distinct capability check and existing driver lifecycle:

```sh
bun /absolute/packet/runner.mjs /absolute/packet \
  http://127.0.0.1:19438 19447 /absolute/desktop-results
```

Start the task-owned desktop `safaridriver` using the host's existing workflow, and stop it after
the runner deletes its own session. Remove transferred packets after saving the small results.
Linux Playwright WebKit, actual desktop Safari, an iPhone simulator and a physical iPhone are
separate qualification targets. A C4D2 simulator result does not qualify a physical iPhone.

## Run adapter controls

Unit controls check CLI selection, typed inventory, result validation, failure propagation,
packet identity and changed bytes without native resources:

```sh
bun test packages/waffle/tests/threads-runtime-safari-runner.test.ts \
  packages/waffle/tests/page-runner/threads-runtime-suite.test.ts
```

The opt-in Chromium control runs the actual Runtime through the same typed page adapter,
then rejects changed fixture bytes. It validates the adapter, not native Safari:

```sh
THREAD_FIXTURE_DIR=/absolute/fixture THREAD_RUNTIME_BROWSER_CONTROLS=1 \
  bun test packages/waffle/tests/page-runner/threads-runtime-browser.test.ts
```
