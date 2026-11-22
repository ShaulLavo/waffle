import { expect, test } from "bun:test";
import { atomicsWaitAsyncFor } from "../proc/intrinsics.ts";

function word(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(4));
}

test("a changed word answers not-equal without waiting", () => {
  const cells = word();
  Atomics.store(cells, 0, 1);
  expect(atomicsWaitAsyncFor(cells, 0, 0, 10)).toEqual({ async: false, value: "not-equal" });
});

test("a timed wait with no notify times out", async () => {
  const waiting = atomicsWaitAsyncFor(word(), 0, 0, 5);
  expect(waiting.async).toBe(true);
  expect(await waiting.value).toBe("timed-out");
});

test("overlapping polls of one word all wake on a notify", async () => {
  const cells = word();
  const first = atomicsWaitAsyncFor(cells, 0, 0, 60_000);
  const second = atomicsWaitAsyncFor(cells, 0, 0, 60_000);
  expect(first.async && second.async).toBe(true);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
  expect(await Promise.all([first.value, second.value])).toEqual(["ok", "ok"]);
});

test("a poll that timed out leaves later polls of the same value wakeable", async () => {
  const cells = word();
  expect(await atomicsWaitAsyncFor(cells, 0, 0, 5).value).toBe("timed-out");
  const later = atomicsWaitAsyncFor(cells, 0, 0, 60_000);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
  expect(await later.value).toBe("ok");
});

test("an untimed wait passes through to the native wait", async () => {
  const cells = word();
  const waiting = atomicsWaitAsyncFor(cells, 0, 0, Infinity);
  expect(waiting.async).toBe(true);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
  expect(await waiting.value).toBe("ok");
});
