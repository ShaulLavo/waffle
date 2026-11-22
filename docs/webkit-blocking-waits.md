# Blocking waits on WebKit

On WebKit, a Waffle sleep wakes a few times in its first seconds and allocates a little. This
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

`atomicsWait` in `proc/intrinsics/wait.ts` is the wait Waffle's own sleeps go through. On
WebKit it wraps the native call:

- A sleep first wakes after 16 ms, then at doubling intervals. The eighth and last wake comes
  about four seconds in. After it the Worker allocates nothing, so no new cycle can open, and
  the rest of the sleep is one native wait.
- Each wake allocates about a thousand small objects. That reaches the engine's allocation slow
  path, where the sleeping Worker finishes the cycle it holds and releases the helpers.
- A wait that is notified within 16 ms makes one native call, as before.
- Consecutive short waits share one schedule, so a loop of 10 ms waits also gives the collector
  its turns. Running for more than a millisecond between waits starts the schedule over.
- A call that does not wait, and a call whose arguments are not plain numbers, goes straight to
  the native wait.

A process Worker also replaces its realm's `Atomics.wait` with the same function, so guest
JavaScript that sleeps there cooperates too.

## Wake semantics

Between two slices the Worker is off the wait queue for the few microseconds the allocation
takes. A notify that lands in that gap is seen only through the value: the next slice returns
`"not-equal"` if the value changed, and the notify is missed if it did not. This can happen only
during the first four seconds of a sleep.

- Every word Waffle sleeps on through `atomicsWait` is changed by its producer before the
  notify, so these waits are unaffected.
- A guest futex may be woken without a change to its word. The group `futex_wait` and the
  supervised Wasm waits therefore use the engine's own wait, `atomicsWaitNative`, and keep its
  exact queue semantics.
- Guest JavaScript in a process Worker gets the cooperative wait. Code that waits on a value and
  rechecks it is unaffected. Code that relies on a notify with no change to the value can miss
  one that lands in a gap.

## What it does not cover

- A guest futex wait, and a Wasm guest that parks with the `memory.atomic.wait32` instruction,
  sleep through the engine's own wait. A guest thread that sleeps this way with a cycle open can
  still hold the helpers.
- A Worker that computes for a long time without allocating holds them for that time.
- Guest code that instantiates its own Wasm module past the fast-memory limit takes the same
  synchronous collection as a process start.

A held helper delays other Workers' collections; only an endless wait makes the delay permanent.

## Tests

- `bun packages/waffle/tests/sleeping-collector-browser-runner.ts webkit` starts Workers beside
  sleeping ones. With Waffle's wait every start must finish. The same starts with the native
  wait are the control: on an affected WebKit one of them stalls, and the runner prints how
  many.
- `bun packages/waffle/tests/process-start-browser-runner.ts` checks in a real process Worker
  that the realm's `Atomics.wait` is Waffle's wait, and that it wraps the engine's only on
  WebKit.
