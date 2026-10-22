import { expect, spyOn, test } from "bun:test";
import { before, evidenceJson, failureValue, failureReasons, type Outcome } from "./filesystem-shutdown-browser.js";

type Stamp = { wallMs: number; monotonicMs: number };
type BeforeRecord<T> =
  | { kind: "started"; at: Stamp; effectiveMs: number; timerDueMonotonicMs: number }
  | { kind: "timer-fired"; at: Stamp }
  | { kind: "operation-returned"; promise: Promise<T>; at: Stamp }
  | { kind: "operation-settled"; outcome: Outcome<T>; at: Stamp }
  | { kind: "returned"; outcome: Outcome<T>; at: Stamp };

// Widening a callable with an optional recorder keeps the baseline executable and
// type-correct. The baseline ignores it, exposing the missing observation at the
// actual before boundary rather than testing a second race implementation.
const recordedBefore: <T>(
  deadline: number,
  phase: string,
  run: () => Promise<T>,
  maximumMs?: number,
  record?: (event: BeforeRecord<T>) => void,
) => Promise<Outcome<T>> = before;

function clockFixture() {
  const handle = setTimeout(() => {}, 2_147_483_647);
  handle.unref();
  let wallMs = 10_000;
  let monotonicMs = 200;
  let fire: (() => void) | undefined;
  let delay: number | undefined;
  const wall = spyOn(Date, "now").mockImplementation(() => wallMs);
  const monotonic = spyOn(performance, "now").mockImplementation(() => monotonicMs);
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, timeout) => {
    if (typeof callback !== "function") throw new Error("Expected a timer callback");
    fire = () => callback();
    delay = timeout;
    return handle;
  });
  return {
    expire() {
      wallMs += 1000;
      monotonicMs += 1000;
      if (!fire) throw new Error("Actual before timer was not installed");
      expect(delay).toBe(1000);
      fire();
    },
    close() {
      timer.mockRestore();
      wall.mockRestore();
      monotonic.mockRestore();
      clearTimeout(handle);
    },
  };
}

async function lateClose(reason: unknown, reject: boolean) {
  const clock = clockFixture();
  const original = Promise.withResolvers<void>();
  const called = Promise.withResolvers<void>();
  const records: BeforeRecord<void>[] = [];
  const primary = new Error("distinct primary failure");
  let calls = 0;
  try {
    const bounded = recordedBefore(55_000, "owned context close", () => {
      calls++;
      called.resolve();
      return original.promise;
    }, 1000, (event) => records.push(event));
    await called.promise;
    clock.expire();
    const invalid = await bounded;
    expect(invalid).toEqual({ kind: "invalid", cause: "owned context close: deadline expired" });
    if (reject) original.reject(reason);
    else original.resolve();
    // Join only the test-controlled operation, never a wall-clock grace period.
    await original.promise.catch(() => {});
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(await bounded).toBe(invalid);
    const returned = records.find((event) => event.kind === "operation-returned");
    expect(returned?.kind).toBe("operation-returned");
    if (returned?.kind !== "operation-returned") throw new Error("Original close promise was not retained");
    expect(returned.promise).toBe(original.promise);
    const settled = records.find((event) => event.kind === "operation-settled");
    expect(settled?.kind).toBe("operation-settled");
    if (settled?.kind !== "operation-settled") throw new Error("Late original outcome was not retained");
    expect(settled.outcome.kind).toBe(reject ? "rejected" : "fulfilled");
    if (settled.outcome.kind === "rejected") expect(Object.is(settled.outcome.reason, reason)).toBe(true);
    const evidence = { primary: { kind: "rejected", reason: primary }, cleanup: settled.outcome, bounded: invalid };
    expect(evidence.primary.reason).toBe(primary);
    expect(evidenceJson(evidence)).toContain("distinct primary failure");
    expect(records.map((event) => event.kind)).toEqual([
      "started", "operation-returned", "timer-fired", "returned", "operation-settled",
    ]);
  } finally {
    original.resolve();
    clock.close();
  }
}

test("actual before retains the one deferred close after its timer wins", () => lateClose(undefined, false));
for (const reason of failureReasons)
  test(`actual before retains late original rejection without falsy loss: ${reason}`, () => lateClose(failureValue(reason), true));
