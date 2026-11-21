# Browser workaround evidence

Waffle maintainers track the code that carries each workaround, the environments that needed it,
and the evidence required to remove it. Versions identify recorded runs. An unmeasured environment
has unknown scope. Keep Linux Playwright WebKit, shipped macOS Safari, iOS Simulator Safari, and
physical iPhone results separate.

**Reproduced** means a recorded run observed the behavior. A browser defect requires an isolated
control. **Suspected** marks a proposed explanation without that proof. **Reported** means an
upstream report exists. A report drafted locally does not count. **Fixed** names the layer where
the correction landed. **Retired** means Waffle removed the workaround after its removal check.

## Guest watch loses a wake after a quiet write

- **Site.** The notification relay uses reusable blocking wait Workers for guest watch forwarding.
  [Relay](../packages/waffle/browser/notification-worker.ts) and
  [blocking wait](../packages/waffle/browser/notification-blocking-wait.ts).
- **Evidence.** Reproduced on Linux Playwright WebKit 2370. Native `Atomics.notify` returned 1,
  but the relay's `Atomics.waitAsync` promise stayed pending. An isolated native Worker resumed
  after an unrelated message, without a second notify. The Waffle failure is fixed by PR 375.
  macOS Safari, iOS Simulator Safari, and physical iPhone scope are unknown.
  [Reproduction and engine revision](browser-runtime.md#serial-guest-watch-notification-stall).
- **Cost.** Up to three reusable blocking wait Workers per guest. The relay remains event-driven.
- **Removal check.** Before switching back to native async waits, repeat the isolated handoffs
  and real quiet and socket-ordered watch writes with the workaround disabled on supported
  affected engines. Require each successful notify to settle without an unrelated message and
  the guest to receive the notice. Retain the blocking-worker path as a positive control.

## Worker termination and shared-page reuse

- **Site.** The broker signals the guest and waits for an unwind report before native termination
  when applicable. The memory group withholds pages while a running member's exit is unproved
  and wakes retired wait records when the group ends. [Broker](../packages/waffle/browser/process-broker.ts)
  and [group lifetime contract](../docs/memory-groups.md#lifetime-and-physical-stop).
- **Evidence.** Reproduced on Linux Playwright WebKit 27.2 and iOS Simulator Safari 26.5.
  A busy Wasm guest can continue writing after `Worker.terminate()`. The simulator can also
  leave a terminated untimed waiter holding a Web Lock. The matched Linux WebKit sleeper
  released its lock. [Matched controls](group-futex-retirement.md#gap-1-running-member-reuse).
- **Cost.** A non-polling guest can consume the one-second unwind cap. Unproved busy exits
  withhold pages. Final retirement can wake a raw waiter, which must recheck its condition.
- **Removal check.** Require actual Worker exit, no writes after reuse, and a surviving page
  in matched busy, polling, and parked cases. Keep generic ownership and reuse checks.

## Reservation and thread qualification

[Named workload qualification (#284)](https://github.com/ShaulLavo/waffle/issues/284) owns broader
workload and device measurements. See the [thread runner](../docs/threads-runtime-runner.md)
and [reservation measurements](../docs/reservation-defaults-later.md) for the respective scope.
[Waffle PR 272](https://github.com/ShaulLavo/waffle/pull/272) is closed as superseded.
Omitted `sharedMemory` still selects the unbounded default on every engine, with no browser
classification or startup probe.
