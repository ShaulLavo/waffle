import { expect, test } from "bun:test";
import {
  createCooperativeWait,
  FIRST_WAKE_MS,
  LAST_WAKE_MS,
  needsCooperativeWait,
  youngCells,
} from "../proc/intrinsics/wait.ts";

type Result = "ok" | "not-equal" | "timed-out";

/**
 * A native wait on a manual clock: each call sleeps its whole timeout unless an answer is
 * queued. `allocationMs` is how long each wake's allocation takes.
 */
function harness(answers: Array<{ result: Result; after: number }> = [], allocationMs = 0) {
  let now = 1000;
  let clockReads = 0;
  const calls: unknown[][] = [];
  let allocations = 0;
  const native = ((...args: unknown[]) => {
    calls.push(args);
    const raw = args[3];
    const timeout = typeof raw !== "number" || Number.isNaN(raw) ? Infinity : Math.max(0, raw);
    const answer = answers.shift();
    if (answer && answer.after <= timeout) {
      now += answer.after;
      return answer.result;
    }
    if (answer) answers.unshift({ result: answer.result, after: answer.after - timeout });
    now += timeout;
    return "timed-out";
  }) as typeof Atomics.wait;
  const wait = createCooperativeWait(
    native,
    () => {
      clockReads++;
      return now;
    },
    () => {
      allocations++;
      now += allocationMs;
    },
  );
  const cells = new Int32Array(new SharedArrayBuffer(4));
  return {
    cells,
    wait: (timeout?: number) => wait(cells, 0, 0, timeout),
    raw: wait as (...args: unknown[]) => Result,
    calls,
    slices: () => calls.map((call) => call[3]),
    allocations: () => allocations,
    clockReads: () => clockReads,
    now: () => now,
    run: (ms: number) => {
      now += ms;
    },
  };
}

test("a wait that is answered before the first wake is one native call", () => {
  const { wait, slices, allocations, clockReads } = harness([{ result: "ok", after: 3 }]);
  expect(wait()).toBe("ok");
  expect(slices()).toEqual([FIRST_WAKE_MS]);
  expect(allocations()).toBe(0);
  expect(clockReads()).toBe(2);
});

test("a short timeout passes through and returns timed-out on time", () => {
  const { wait, slices, allocations, now } = harness();
  const start = now();
  expect(wait(5)).toBe("timed-out");
  expect(slices()).toEqual([5]);
  expect(now() - start).toBe(5);
  expect(allocations()).toBe(0);
});

test("a long wait wakes at doubling intervals and allocates each time", () => {
  const { wait, slices, allocations, now } = harness();
  const start = now();
  expect(wait(1000)).toBe("timed-out");
  expect(now() - start).toBe(1000);
  expect(slices()).toEqual([16, 32, 64, 128, 256, 504]);
  expect(allocations()).toBe(5);
});

test("a wake allocates fresh cells for the collector by default", () => {
  let now = 0;
  const native = ((_array: Int32Array, _index: number, _value: number, timeout: number) => {
    now += timeout;
    return "timed-out";
  }) as typeof Atomics.wait;
  const wait = createCooperativeWait(native, () => now);
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const before = youngCells();
  wait(cells, 0, 0, 40);
  const first = youngCells();
  expect(first).not.toBe(before);
  let length = 0;
  for (let cell = first as { next: unknown } | null; cell; cell = cell.next as typeof cell)
    length++;
  expect(length).toBe(1024);
});

test("a sleep stops waking after the last interval and finishes in one native wait", () => {
  const { wait, slices, allocations } = harness();
  expect(wait(20_000)).toBe("timed-out");
  expect(slices()).toEqual([16, 32, 64, 128, 256, 512, 1024, LAST_WAKE_MS, 20_000 - 4080]);
  expect(allocations()).toBe(8);
});

test("an untimed sleep ends in an untimed native wait", () => {
  const { wait, slices } = harness([{ result: "ok", after: 60_000 }]);
  expect(wait()).toBe("ok");
  expect(slices().at(-1)).toBe(Infinity);
  expect(slices()).toHaveLength(9);
});

test("a notify between wakes returns the native result", () => {
  const { wait, allocations } = harness([{ result: "ok", after: 100 }]);
  expect(wait()).toBe("ok");
  // Wakes fall 16 and 48 ms into the wait; the notify at 100 ms comes before the third.
  expect(allocations()).toBe(2);
});

test("back-to-back short waits share one schedule", () => {
  const { wait, allocations } = harness();
  for (let slice = 0; slice < 10; slice++) expect(wait(10)).toBe("timed-out");
  // 100 ms of sleeping in 10 ms slices crosses the wakes at 16 and 48 ms, not the one at 112.
  expect(allocations()).toBe(2);
});

test("back-to-back short waits stop waking once the schedule is done", () => {
  const { wait, allocations } = harness();
  for (let slice = 0; slice < 1000; slice++) wait(10);
  expect(allocations()).toBe(8);
});

test("running between waits restarts the schedule", () => {
  const { wait, calls, slices, run } = harness();
  wait(200);
  run(5);
  calls.length = 0;
  wait(20);
  expect(slices()).toEqual([FIRST_WAKE_MS, 4]);
});

test("a wake that outlasts the deadline returns timed-out without waiting again", () => {
  const { wait, calls } = harness([], 30);
  expect(wait(20)).toBe("timed-out");
  expect(calls).toHaveLength(1);
});

test("a call that does not wait goes straight to the native wait", () => {
  const zero = harness();
  expect(zero.wait(0)).toBe("timed-out");
  const negative = harness();
  expect(negative.wait(-5)).toBe("timed-out");
  expect(zero.slices()).toEqual([0]);
  expect(negative.slices()).toEqual([-5]);
  expect(zero.clockReads() + negative.clockReads()).toBe(0);
});

test("NaN and a missing timeout wait forever", () => {
  const forever = harness([{ result: "ok", after: 10_000 }]);
  expect(forever.wait(Number.NaN)).toBe("ok");
  const missing = harness([{ result: "ok", after: 10_000 }]);
  expect(missing.wait()).toBe("ok");
});

test("arguments the native wait would convert reach it once and untouched", () => {
  let conversions = 0;
  const value = {
    valueOf() {
      conversions++;
      return 0;
    },
  };
  const timeout = { valueOf: () => 500 };
  const first = harness();
  first.raw(first.cells, 0, value, 500);
  const second = harness();
  second.raw(second.cells, 0, 0, timeout);
  const third = harness();
  third.raw(third.cells, "0", 0, 500);
  expect(first.calls).toEqual([[first.cells, 0, value, 500]]);
  expect(second.calls).toEqual([[second.cells, 0, 0, timeout]]);
  expect(third.calls).toEqual([[third.cells, "0", 0, 500]]);
  expect(conversions).toBe(0);
  expect(first.clockReads() + second.clockReads() + third.clockReads()).toBe(0);
});

test("a 64-bit wait is cooperative too", () => {
  const { raw, slices, allocations } = harness();
  const cells = new BigInt64Array(new SharedArrayBuffer(8));
  expect(raw(cells, 0, 0n, 100)).toBe("timed-out");
  expect(slices()).toEqual([16, 32, 52]);
  expect(allocations()).toBe(2);
});

test("a value mismatch returns at once", () => {
  const { wait, calls } = harness([{ result: "not-equal", after: 0 }]);
  expect(wait(500)).toBe("not-equal");
  expect(calls).toHaveLength(1);
});

test("only WebKit user agents need the cooperative wait", () => {
  const safari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
  const chromeOnIphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1";
  const chrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
  const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0";
  expect(needsCooperativeWait(safari)).toBe(true);
  expect(needsCooperativeWait(chromeOnIphone)).toBe(true);
  expect(needsCooperativeWait(chrome)).toBe(false);
  expect(needsCooperativeWait(firefox)).toBe(false);
  expect(needsCooperativeWait("Bun/1.4.4")).toBe(false);
  expect(needsCooperativeWait(undefined)).toBe(false);
});
