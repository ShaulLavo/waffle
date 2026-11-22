import { expect, test } from "bun:test";
import { atomicsWaitAsyncFor } from "../proc/intrinsics.ts";
import {
  abandonedPollsLeaveNoWaiter,
  notifyDuringWaitWakes,
  retryIgnoresEarlierNotify,
  waitAsyncContractExpected as expected,
  zeroTimeoutPolls,
} from "./wait-async-contract.ts";

test("timed-out polls leave no waiter to take a count-1 notify", async () => {
  expect(await abandonedPollsLeaveNoWaiter()).toEqual(expected.abandoned);
});

test("a retry does not report a notify from before it started", async () => {
  expect(await retryIgnoresEarlierNotify()).toEqual(expected.retry);
});

test("a zero timeout stays a synchronous poll, also through RecordRing", () => {
  expect(zeroTimeoutPolls()).toEqual(expected.zero);
});

test("a notify during the wait wakes it", async () => {
  expect(await notifyDuringWaitWakes()).toEqual(expected.notify);
});

test("a changed word answers not-equal without waiting", () => {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cells, 0, 1);
  expect(atomicsWaitAsyncFor(cells, 0, 0, 10)).toEqual({ async: false, value: "not-equal" });
});

test("an untimed wait passes through to the native wait", async () => {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const waiting = atomicsWaitAsyncFor(cells, 0, 0, Infinity);
  expect(waiting.async).toBe(true);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
  expect(await waiting.value).toBe("ok");
});
