import { expect, test } from "bun:test";
import {
  createNotificationWaitSet,
  type NotificationWaitResult,
} from "../browser/notification-wait.js";

function source(log: string[], name: string, fail = false) {
  return {
    kind: "covered" as const,
    register(_wake: Int32Array) {
      log.push(`register:${name}`);
      if (fail) throw new Error(`${name} failed`);
      return () => log.push(`release:${name}`);
    },
  };
}

test("mixed wait samples before readiness and keeps an absolute deadline after an early wake", () => {
  const log: string[] = [];
  const times = [104, 109];
  const waits: number[] = [];
  const set = createNotificationWaitSet([source(log, "fs")], {
    now: () => times.shift() ?? 109,
    wait(_wake, observed, timeout) {
      waits.push(timeout);
      return observed === 0 ? "not-equal" : "timed-out";
    },
  });
  const observed = set.sample();
  Atomics.add(set.wake, 0, 1);
  expect(set.wait(observed, 120)).toBe("not-equal");
  expect(set.wait(set.sample(), 120)).toBe("timed-out");
  expect(waits).toEqual([16, 11]);
  set.dispose();
  expect(log).toEqual(["register:fs", "release:fs"]);
});

test("uncovered sources report bounded coverage without changing notification forwarding", () => {
  const log: string[] = [];
  const waits: number[] = [];
  const set = createNotificationWaitSet([source(log, "process"), { kind: "uncovered" }], {
    wait(wake, observed) {
      waits.push(10);
      return Atomics.load(wake, 0) === observed ? "timed-out" : "not-equal";
    },
  });
  expect(set.covered).toBe(false);
  const observed = set.sample();
  expect(set.wait(observed, Infinity)).toBe("timed-out");
  expect(waits).toEqual([10]);
  Atomics.add(set.wake, 0, 1);
  expect(set.wait(observed, Infinity)).toBe("not-equal");
  set.dispose();
  expect(log).toEqual(["register:process", "release:process"]);
});

test("arming failure releases earlier sources in reverse order", () => {
  const log: string[] = [];
  expect(() =>
    createNotificationWaitSet([source(log, "first"), source(log, "second", true)]),
  ).toThrow("second failed");
  expect(log).toEqual(["register:first", "register:second", "release:first"]);
});

test("dispose wakes blocked callers and cleanup remains one-shot when a release throws", () => {
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const log: string[] = [];
  const set = createNotificationWaitSet(
    [
      {
        kind: "covered",
        register() {
          return () => {
            log.push("release:throw");
            throw new Error("release failed");
          };
        },
      },
      source(log, "last"),
    ],
    {
      wait: () => "timed-out" as NotificationWaitResult,
    },
  );
  const observed = set.sample();
  expect(set.wait(observed, Infinity)).toBe("timed-out");
  expect(() => set.dispose()).toThrow("release failed");
  expect(set.disposed).toBe(true);
  expect(set.wait(observed, Infinity)).toBe("not-equal");
  expect(log).toEqual(["register:last", "release:last", "release:throw"]);
  expect(() => set.dispose()).not.toThrow();
  expect(wake).toBeInstanceOf(Int32Array);
});
