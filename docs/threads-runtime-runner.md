# Run the Runtime thread fixture

Each case uses the page's single `createRuntime()` instance. The Rust cases use the verified
producer, and the other cases compile generated Wasm through the Runtime's normal admission path.

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
run the full Playwright corpus. Repeat `--case NAME` to select specific cases. Each case gets a
fresh document with COOP and COEP for shared memory and real Workers.

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
an exact simulator UUID, validates iOS Simulator capabilities, and runs the original nine cases
listed below. The desktop Safari runner uses that same nine-case inventory.
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
commit or fixture digest is hardcoded in source. Preparation requires production source to match
current HEAD and checks source consistency again after bundling. The source hashes describe the
actual entries, including local harness edits if preparation precedes their commit.

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

## Regression coverage

Every threaded guest uses shared `env.memory` and `wasi:thread-spawn`. Runtime admission
instruments guest code with its private fatal checkpoint and wait imports. The ordinary
Preview 1 sibling runs on a separate PID and uses real `path_open` and file I/O after the
threaded process exits.

### Original cases on Playwright and native Safari

| Thread plan slice | Case and guest operations                                                                                                                                                      | Outcome                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| S0, S2, S4        | `pair`, `repeat`, `nested`. The Rust guest uses `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get`, `clock_time_get`, `fd_write`, `proc_exit` and `sched_yield`. | Rust spawn and join preserve the expected TLS, stacks and results after child return.     |
| S0, S2            | `join` uses `fd_write` and wait32/notify.                                                                                                                                      | A secondary writes `c` before the initial guest returns.                                  |
| S2                | `child-exit` uses `proc_exit` and wait64.                                                                                                                                      | Secondary `proc_exit(0)` ends the process while the initial guest is waiting.             |
| S2, S3            | `kill-start`, `cpu`, `wait32`, `wait64` use the supervised startup, polling and native wait paths.                                                                             | SIGKILL stops the target, and collection waits for the held filesystem section to finish. |

### Additional Playwright cases

| Thread plan slice | Case and guest operations                                                                                                                                        | Outcome                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1                | `fd-read`, `fd-write` use inherited files, `fd_read`, `fd_write`, `fd_seek`, `fd_tell`, `fd_fdstat_get` and `fd_close`.                                          | Two threads of one PID observe a shared cursor and host-updated NONBLOCK flag. A held file read or write finishes on the original open description after close and rebind. The old reference drains and the replacement's cursor, flags and bytes stay independent.                                                                 |
| S2                | `fatal-exit` uses `fd_read`, finite wait64 and `proc_exit`.                                                                                                      | An exit from a secondary returns code 23 while a same-PID stdin call and timed wait are pending. Every guest retires, the filesystem fence holds collection, and no aborted call or guest epilogue publishes a write.                                                                                                               |
| S2, S3            | `admission` uses nested spawn, wait32 and an `fd_write` canary.                                                                                                  | Four slots include the initial guest and a guest paused in its Wasm start section. The next spawn returns signed `-6` both while that guest is pending and after it enters. Ordinary return frees a slot, and replayed ready and idle messages from the retired Worker leave the replacement pending until its own ready.           |
| S0, S2            | `tid-boundaries` uses the real spawn import and a test-set allocator cursor. The compiled guest import tests also inject invalid success values 0 and 536870912. | IDs 65535, 65536 and 536870911 appear unchanged in the spawn result and the receiving guest's entry argument. Exhaustion returns signed `-6` without a Worker. Invalid success values fail before the compiled store.                                                                                                               |
| S3                | `growth` uses imported memory, `memory.grow`, wait32 and `fd_write`.                                                                                             | The initial guest grows memory from two to three pages during the receiving Worker's Wasm start section, then to four after instantiation. Compiled reads and service writes cross both old bounds. The receiver reports its saved and reacquired views. A tracking view on a cloned alias is checked when conversion is supported. |
| S2, S4            | `overlapping-waits` uses finite wait32 and wait64 plus an `fd_write` canary.                                                                                     | Both native waits are still registered after the independent service call completes. The later waiter reports a notification and timeout while the earlier waiter stays parked. The earlier waiter then reports the same results. Durations are recorded for diagnosis.                                                             |

To rerun just these controls on Linux, pass all seven selectors to the same runner:

```sh
THREAD_FIXTURE_DIR=/absolute/fixture PROCESS_SCRATCH_ROOT=/absolute/scratch \
  bun packages/waffle/tests/threads-runtime-browser-runner.ts chromium firefox webkit \
  --case fd-read --case fd-write --case fatal-exit --case admission --case tid-boundaries \
  --case growth --case overlapping-waits
```

The S1 descriptor slice owns threaded `path_open` and `fd_fdstat_set_flags`. The S2 lifecycle
slice owns any explicit `thread_exit` import. The streams and readiness work in S4 owns
threaded `poll_oneoff`. These imports remain outside experimental admission. Native Safari
qualification for the additional cases and physical device measurements are tracked separately.
