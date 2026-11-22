import { RecordRing } from "../browser/gpu/ring.ts";
import { atomicsWaitAsyncFor } from "../proc/intrinsics.ts";

// Contract cases for atomicsWaitAsyncFor, shared by the Bun unit test and the browser check.
// Each returns what it observed; callers compare against the native Atomics.waitAsync contract.

type NativeWaitAsync = (
  array: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { async: false; value: string } | { async: true; value: Promise<string> };
const nativeWaitAsync = (Atomics as unknown as { waitAsync: NativeWaitAsync }).waitAsync;

async function settle(
  waiting: { async: false; value: string } | { async: true; value: Promise<string> },
) {
  return waiting.async ? await waiting.value : waiting.value;
}

/** Timed-out polls through distinct views of one cell must leave no native waiter that could
 * take a later count-1 notify from a live waiter. */
export async function abandonedPollsLeaveNoWaiter() {
  const buffer = new SharedArrayBuffer(4);
  for (let view = 0; view < 4; view++)
    await settle(atomicsWaitAsyncFor(new Int32Array(buffer), 0, 0, 5));
  const cells = new Int32Array(buffer);
  const live = nativeWaitAsync(cells, 0, 0, 2000);
  const woken = Atomics.notify(cells, 0, 1);
  const liveResult = await settle(live);
  const leftover = Atomics.notify(cells, 0);
  return { woken, liveResult, leftover };
}

/** A retry started after a notify must not report that earlier notify as its own wake. */
export async function retryIgnoresEarlierNotify() {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const first = await settle(atomicsWaitAsyncFor(cells, 0, 0, 5));
  const earlier = Atomics.notify(cells, 0);
  const retry = await settle(atomicsWaitAsyncFor(cells, 0, 0, 30));
  return { first, earlier, retry };
}

/** A zero timeout is a synchronous poll, through the helper and through RecordRing. */
export function zeroTimeoutPolls() {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const helper = atomicsWaitAsyncFor(cells, 0, 0, 0);
  const ring = new RecordRing(new SharedArrayBuffer(64 + 128), 16);
  const ringResult = ring.waitAsync(ring.sequence(), 0);
  return {
    helper: { async: helper.async, value: helper.async ? "promise" : helper.value },
    ring: { async: ringResult.async, value: ringResult.async ? "promise" : ringResult.value },
    leftover: Atomics.notify(cells, 0),
  };
}

/** A notify during the wait wakes it with "ok". */
export async function notifyDuringWaitWakes() {
  const cells = new Int32Array(new SharedArrayBuffer(4));
  const waiting = atomicsWaitAsyncFor(cells, 0, 0, 2000);
  const woken = Atomics.notify(cells, 0, 1);
  return { woken, result: await settle(waiting) };
}

export const waitAsyncContractExpected = {
  abandoned: { woken: 1, liveResult: "ok", leftover: 0 },
  retry: { first: "timed-out", earlier: 0, retry: "timed-out" },
  zero: {
    helper: { async: false, value: "timed-out" },
    ring: { async: false, value: "timed-out" },
    leftover: 0,
  },
  notify: { woken: 1, result: "ok" },
} as const;

export async function waitAsyncContract() {
  return {
    abandoned: await abandonedPollsLeaveNoWaiter(),
    retry: await retryIgnoresEarlierNotify(),
    zero: zeroTimeoutPolls(),
    notify: await notifyDuringWaitWakes(),
  };
}
