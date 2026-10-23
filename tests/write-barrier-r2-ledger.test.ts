import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { WriteAdmission, WRITE_BARRIER_OFFSET, WRITE_BARRIER_WORDS } from "../fs/write-barrier";

test("a full async ledger does not publish a change on a rejected admission", () => {
  const gate = new WriteAdmission(SharedFilesystemState.createBuffer());
  const tickets = Array.from({ length: 63 }, () => gate.admit(1, 0, undefined, 0, true));
  const cells = new Int32Array(gate.buffer, WRITE_BARRIER_OFFSET);
  const waiting = 8;
  Atomics.store(cells, waiting, 1);
  const observed = gate.change;
  try {
    expect(() => gate.admit(1, 0, undefined, 0, true)).toThrow();
    expect(gate.change).toBe(observed);
  } finally {
    Atomics.store(cells, waiting, 0);
    for (const ticket of tickets) gate.finish(ticket);
  }
});


test("a stale ticket cannot release a reused slot across the low serial rollover", () => {
  const gate = new WriteAdmission(SharedFilesystemState.createBuffer());
  const stale = gate.admit(7);
  gate.finish(stale);
  const cells = new Int32Array(gate.buffer, WRITE_BARRIER_OFFSET);
  Atomics.store(cells, 2, 0x7fffffff);
  const current = gate.admit(7);
  expect(current.slot).toBe(stale.slot);
  expect(current.serial % 0x80000000).toBe(stale.serial);
  expect(current.serial).not.toBe(stale.serial);
  gate.finish(stale);
  expect(gate.active).toBe(1);
  gate.verify(current);
  gate.finish(current);
  expect(gate.active).toBe(0);
});
