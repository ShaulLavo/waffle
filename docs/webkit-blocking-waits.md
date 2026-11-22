# Blocking waits on WebKit

On WebKit, every blocking wait in Waffle wakes at growing intervals and allocates a little. This
keeps a sleeping Worker from stopping garbage collection in the rest of the page, which could
otherwise hang a process start for good.

## The engine behavior

- A Worker parked in `Atomics.wait` keeps access to its heap. A collection cycle that is open in
  that Worker when it parks stays open until the Worker runs again.
- All Workers of a page share one small pool of marking helper threads. Helpers that joined an
  open cycle stay parked in it until that cycle ends.
- A collection in another Worker can then wait for helpers that never come. Most of the time
  nothing notices. A synchronous collection does: the Worker that asked for it never returns.
- WebKit runs a synchronous collection inside `new WebAssembly.Instance` and
  `new WebAssembly.Memory` once the page holds its limit of fast Wasm memories (eight on desktop
  builds). A page with nine live processes is past that limit, so each later start collects
  first.

Together: a process that sleeps with a cycle open, plus a ninth process starting, can leave the
new process stopped inside `new WebAssembly.Instance`. When the sleeper waits for that process,
nothing ever wakes either of them. Chromium and Firefox do not behave this way.

## What Waffle does

`atomicsWait` in `proc/intrinsics/wait.ts` is the wait every Waffle sleep goes through. On
WebKit it wraps the native call:

- A wait first wakes after 16 ms, then at doubling intervals up to about two seconds.
- Each wake allocates about a thousand small objects. That reaches the engine's allocation slow
  path, where the sleeping Worker finishes the cycle it holds and releases the helpers.
- A wait that is notified within 16 ms makes one native call, as before.
- Consecutive short waits share one schedule, so a loop of 10 ms waits also gives the collector
  a turn. Running for more than a millisecond between waits starts the schedule over.

A process Worker also replaces its realm's `Atomics.wait` with the same function, so guest
JavaScript that sleeps there cooperates too.

Results and timeouts match `Atomics.wait`, with one difference. A notify that lands during a
wake is seen as `"not-equal"` if the value changed, and is missed if it did not. Code that waits
on a value and rechecks it, which is the only reliable way to use a futex, is unaffected.

## What it does not cover

- A Wasm guest that parks with the `memory.atomic.wait32` instruction never enters JavaScript,
  so its wait cannot be wrapped. A guest thread that sleeps this way with a cycle open can still
  hold the helpers.
- A Worker that computes for a long time without allocating holds them for that time.

Both delay other Workers' collections; only an endless wait makes the delay permanent.

## Test

`bun packages/waffle/tests/sleeping-collector-browser-runner.ts webkit` starts Workers beside
sleeping ones. With Waffle's wait every start must finish. The same starts with the native wait
are the control: on an affected WebKit one of them stalls, and the runner prints how many.
