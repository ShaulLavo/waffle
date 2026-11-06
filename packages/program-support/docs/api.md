# Shared guest support APIs

`waffle-program-support` owns guest-side execution, descriptors, cancellation and
filesystem operations. It contains no command parser, process-group policy, input
pump, access request, or prompt handler.

## Cancellation and events

`executor::Cancel::child()` has its own cancellation state. Parent cancellation
wakes parked descendants, but canceling a child does not cancel its parent.
`without_probe()` shares that state and suppresses consuming host probes through
its entire parent chain. It still observes explicit cancellation.

`executor::Event::listen()` returns an `EventWait`. A notification between listen
and the first poll is observed. Each wait owns one removable registration.
`notify()` releases the event borrow before waking. Dropping a wait unregisters it.

## Executor timers

`Executor::sleep_until(Instant)` creates an `Unpin` future. Its first poll
registers one deadline and waker, unless the deadline has already passed.
Re-polling updates the waker. Dropping the future removes its registration.
Completed sleeps stay ready. `Sleep::deadline()` returns the original deadline;
`is_elapsed()` reads the completion flag without reading a clock.

`Executor::next_deadline()` returns the earliest registered deadline.
`fire_timers(now)` marks and removes every due registration, then wakes in
deadline and registration order after releasing the registry borrow.
`drive()` fires due timers before polling tasks, and reads the clock only when a
timer is registered. The timer registry does not retain the executor's task map.

`park_if_idle()` returns false while a timer is registered because its host park
primitive has no timeout. Cooperative host drivers use `next_deadline()` with
`runtime::poll_timeout(runnable, deadline, now)` and the existing `Runtime::poll`.
The conversion returns 0 for runnable work or passed deadlines, -1 without a
deadline, and otherwise rounds remaining milliseconds up and clamps to
`i32::MAX`. Drivers need no clock read for runnable or timer-free turns.

## Open descriptions and byte accounting

`io::Endpoint::downgrade()` returns a `WeakEndpoint`. Its `upgrade()` returns a live
endpoint only while a strong owner exists. Weak observers do not defer last-close
EOF or broken-pipe delivery. `same_open()` compares description identity, including
its shared offset. `host_owner()` returns a weak reference to the underlying host
endpoint, also for an exported buffer.

`buffered_input_bytes()` returns the allocated payload capacity of an endpoint made
by `Endpoint::bytes`, not its length or remaining input. `buffered_input_metadata_bytes()`
adds the fixed open-description allocation, shared input allocation and their two
reference-count headers. The formula follows each target's Rust layout.

`buffered_source()` creates a reader over the same bytes and offset without
retaining the export host. `export_buffer(&host_reader)` redirects ordinary reads
and `runtime_fd()` to a retained host endpoint. The source reader still sees the
original bytes. These methods require an endpoint created by `Endpoint::bytes`;
the export reader must be created by `Endpoint::host`. Other inputs panic.

## Read readiness

`Endpoint::read_ready()` observes readiness without consuming bytes, moving an
offset, retaining an endpoint, or registering a waiter. Readiness does not grant
read permission. Write-only regular files and null descriptors are ready even
when their read operation fails.

| Description                               | Read-ready condition                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| File, Null, unexported Bytes, BytesSource | Always, including EOF                                       |
| PipeRead                                  | Buffered bytes or no writers                                |
| PipeWrite                                 | No readers, including the hangup error condition            |
| Capture                                   | Never                                                       |
| Host, exported Bytes                      | Delegate to the host without inspecting the original buffer |

`HostEndpoint::read_ready()` defaults to `IoError::Unsupported`. Invalid runtime
descriptors remain errors. A runtime endpoint calls `Abi::poll` once with its own
fd, kind 0, userdata 0 and timeout 0. It accepts zero events or one matching read
event with no flags except the existing hangup bit. ABI errors and malformed
counts or events are I/O errors.

This single-subscription, zero-time ABI observation may run inside a task. It
does not dispatch or remove runtime waiters. The JavaScript host never waits on
a zero-time poll and returns zero while a signal is pending.

## Reactor and filesystem

`runtime::Runtime::ready(kind, id)` returns a public `Ready`. It registers on its
first poll. The embedding owns the kind and id meanings. `notify(kind, id)` removes
all matching waits and wakes them after releasing the registry borrow. The
embedding publishes its state before notifying. Notifications are not retained for
waits that have not yet registered. `waiter_count()` only observes the registry.
`Runtime::poll()` remains the only waiter-dispatching operation and runs only
between executor turns. The zero-time read observation above calls `Abi::poll`
without entering that dispatcher.

`runtime::Abi` provides `stat(path, follow_symlinks)`, `open_dir(path)` and
`read_dir(fd, cookie, output)`. `Runtime` implements the matching `io::FileSystem`
operations. Directory readers retain one bounded page of `MAX_PATH_BYTES + 24`
bytes, preserve opaque cookies, retry partial page tails, reject stalled or
incomplete first records, and close the descriptor when their last owner drops.

On WASI with `cooperative-wasi`, `runtime::WasiAbi::new()` queries the generic launch
list. `with_inherited_fds(Vec<u32>)` uses a list supplied by the embedding instead.
Both scan only fd 3 through `3 + binding_count` for the root preopen. Sparse high
bindings do not expand the scan. The supplied list excludes private preopens.

`runtime::{decode_descriptor_kind, decode_filestat, decode_permissions}` expose the
neutral wire decoders. Unsupported metadata stays unknown. `runtime::io_error`
converts positive WASI errnos without adding command-specific error handling.

## Development-only stack observations

The default build contains no stack observation code. Tests of this crate, or a
downstream dev-dependency with the `stack-observation` feature, expose
`executor::observation`. It provides `StackObservation` with `poll_bytes`,
`drop_bytes` and `calls`, plus `measure_driver`, `measure_poll`, `measure_drop`,
`measure_calls`, `reset_stack_observation` and `stack_observation`. The executor
records its driver marker on each turn. Downstream tests record their poll and
drop markers; production dependencies must leave this feature disabled.
