import { expect, test } from "bun:test";
import { IntentLedger, unsettled } from "./recovery.js";
import { ParkingGates, type Schedule } from "./parking.js";
import type { Request } from "./protocol.js";
function original(): Request {
  return {
    client: "history/session",
    sequence: 1,
    epoch: 1,
    history: "history",
    actor: "host",
    operation: { kind: "append", path: "/data", text: "once" },
  };
}
test("F3a successful null status cannot resolve an issued mutation", () => {
  const ledger = new IntentLedger();
  const issued = ledger.capture(original());
  ledger.settle(issued, unsettled(issued, "lost"));
  try {
    const status = ledger.capture({
      ...issued,
      operation: { kind: "status", key: "history/session:1" },
    });
    ledger.settle(status, {
      kind: "ok",
      cursor: { epoch: 1, history: "history", generation: 0, watermark: 0, durableWatermark: 0 },
      result: null,
    });
  } catch (error) {
    expect(String(error)).toContain("OP_ID_CONFLICT");
  }
  expect(ledger.unresolved()).toEqual(["history/session:1"]);
});
test("F3b refreshed history cannot reissue an unknown identity", () => {
  const ledger = new IntentLedger();
  const issued = ledger.capture(original());
  ledger.settle(issued, unsettled(issued, "lost"));
  expect(() => ledger.capture({ ...issued, epoch: 2, history: "new-history" })).toThrow(
    "OUTCOME_UNKNOWN",
  );
  expect(ledger.unresolved()).toEqual(["history/session:1"]);
});
class Clock {
  now = 0;
  readonly jobs = new Map<() => void, number>();
  readonly after: Schedule = (callback, milliseconds) => {
    this.jobs.set(callback, this.now + milliseconds);
    return () => {
      this.jobs.delete(callback);
    };
  };
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const [callback, at] of Array.from(this.jobs)) {
      if (at > this.now) continue;
      this.jobs.delete(callback);
      callback();
    }
  }
}
test("F4 an old timer cannot delete a successor's same-name gate", async () => {
  const clock = new Clock();
  const parking = new ParkingGates(clock.after);
  const old = parking.park("G");
  clock.advance(4999);
  const successor = parking.park("G");
  clock.advance(1);
  await old;
  const released = parking.release("G");
  clock.advance(5000);
  await successor;
  expect(released).toBe(true);
  expect(parking.gates.size).toBe(0);
  expect(clock.jobs.size).toBe(0);
});
