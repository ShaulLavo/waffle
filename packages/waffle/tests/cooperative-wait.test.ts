import { expect, test } from "bun:test";
import {
  createCooperativeWait,
  FIRST_WAKE_MS,
  LONGEST_WAKE_MS,
  needsCooperativeWait,
  youngCells,
} from "../proc/intrinsics/wait.ts";

type Result = "ok" | "not-equal" | "timed-out";

/** A native wait on a manual clock: each call sleeps its whole timeout unless an answer is queued. */
function harness(answers: Array<{ result: Result; after: number }> = []) {
  let now = 1000;
  const slices: number[] = [];
  let allocations = 0;
  const native = ((_array: Int32Array, _index: number, _value: number, timeout: number) => {
    slices.push(timeout);
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
    () => now,
    () => {
      allocations++;
    },
  );
  const cells = new Int32Array(new SharedArrayBuffer(4));
  return {
    wait: (timeout?: number) => wait(cells, 0, 0, timeout),
    slices,
    allocations: () => allocations,
    now: () => now,
    run: (ms: number) => {
      now += ms;
    },
  };
}

test("a wait that is answered before the first wake is one native call", () => {
  const { wait, slices, allocations } = harness([{ result: "ok", after: 3 }]);
  expect(wait()).toBe("ok");
  expect(slices).toEqual([FIRST_WAKE_MS]);
  expect(allocations()).toBe(0);
});

test("a short timeout passes through and returns timed-out on time", () => {
  const { wait, slices, allocations, now } = harness();
  const start = now();
  expect(wait(5)).toBe("timed-out");
  expect(slices).toEqual([5]);
  expect(now() - start).toBe(5);
  expect(allocations()).toBe(0);
});

test("a long wait wakes at doubling intervals and allocates each time", () => {
  const { wait, slices, allocations, now } = harness();
  const start = now();
  expect(wait(1000)).toBe("timed-out");
  expect(now() - start).toBe(1000);
  expect(slices).toEqual([16, 32, 64, 128, 256, 504]);
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

test("the interval stops growing at the longest wake", () => {
  const { wait, slices } = harness();
  wait(20_000);
  expect(Math.max(...slices)).toBe(LONGEST_WAKE_MS);
  expect(slices.filter((slice) => slice === LONGEST_WAKE_MS).length).toBeGreaterThan(3);
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

test("running between waits restarts the schedule", () => {
  const { wait, slices, run } = harness();
  wait(200);
  run(5);
  slices.length = 0;
  wait(20);
  expect(slices).toEqual([FIRST_WAKE_MS, 4]);
});

test("timeouts follow Atomics.wait: NaN and undefined wait forever, negatives do not wait", () => {
  const forever = harness([{ result: "ok", after: 10_000 }]);
  expect(forever.wait(Number.NaN)).toBe("ok");
  const missing = harness([{ result: "ok", after: 10_000 }]);
  expect(missing.wait()).toBe("ok");
  const negative = harness();
  expect(negative.wait(-5)).toBe("timed-out");
  expect(negative.slices).toEqual([0]);
});

test("a value mismatch returns at once", () => {
  const { wait, slices } = harness([{ result: "not-equal", after: 0 }]);
  expect(wait(500)).toBe("not-equal");
  expect(slices.length).toBe(1);
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
