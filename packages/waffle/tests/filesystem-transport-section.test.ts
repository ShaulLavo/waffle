import { expect, test } from "bun:test";
import { createFilesystemIdentity } from "../fs/protocol";
import {
  FilesystemRequestPool,
  FilesystemTransportError,
  FilesystemTransportSection,
  closeRequestMemory,
  createRequestBudget,
  requestMemorySections,
  requestTransportError,
  waitForRequestQuiescence,
} from "../fs/request-memory";

function transport() {
  const identity = createFilesystemIdentity(undefined, 16 * 1024 * 1024);
  const pool = new FilesystemRequestPool(createRequestBudget(), 65_536);
  const memory = pool.take(new SharedArrayBuffer(4));
  const signal = new Int32Array(identity.signal);
  return { identity, memory, signal };
}

test("only the exit that empties the count wakes the shared signal", () => {
  const { identity, memory, signal } = transport();
  const outer = new FilesystemTransportSection(identity, memory, () => false);
  const inner = new FilesystemTransportSection(identity, memory, () => false);
  outer.enter();
  inner.enter();
  expect(requestMemorySections(memory)).toBe(2);
  inner.exit();
  expect(Atomics.load(signal, 0)).toBe(0);
  outer.exit();
  expect(Atomics.load(signal, 0)).toBe(1);
  expect(requestMemorySections(memory)).toBe(0);
  // Repeated cycles keep the count exact; every return to zero wakes once.
  for (let round = 0; round < 1000; round++) {
    outer.enter();
    outer.exit();
  }
  expect(Atomics.load(signal, 0)).toBe(1001);
  expect(requestMemorySections(memory)).toBe(0);
});

test("teardown quiescence resolves on the last exit, not before", async () => {
  const { identity, memory } = transport();
  const section = new FilesystemTransportSection(identity, memory, () => false);
  section.enter();
  section.enter();
  closeRequestMemory(memory);
  let quiescent = false;
  const waiting = waitForRequestQuiescence(identity, memory).then(() => {
    quiescent = true;
  });
  section.exit();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(quiescent).toBe(false);
  section.exit();
  await waiting;
  expect(requestMemorySections(memory)).toBe(0);
});

test("a closed transport refuses entry and leaves the count balanced", () => {
  const { identity, memory } = transport();
  const section = new FilesystemTransportSection(identity, memory, () => false);
  closeRequestMemory(memory);
  expect(() => section.enter()).toThrow(FilesystemTransportError);
  expect(requestMemorySections(memory)).toBe(0);
  expect(requestTransportError(memory)?.reason).toBe("messageerror");
});
