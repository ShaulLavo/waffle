import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { WriteAdmission, WRITE_BARRIER_OFFSET } from "../fs/write-barrier";

test("a full async ledger does not publish a change on a rejected admission", () => {
  const gate = new WriteAdmission(SharedFilesystemState.createBuffer());
  const tickets = Array.from({ length: 63 }, () => gate.admit(1, 0, undefined, 0, true));
  const cells = new Int32Array(gate.buffer, WRITE_BARRIER_OFFSET);
  // The last header cell counts registered waiters in the first repair checkpoint.
  Atomics.store(cells, 11, 1);
  const observed = gate.change;
  try {
    expect(() => gate.admit(1, 0, undefined, 0, true)).toThrow();
    expect(gate.change).toBe(observed);
  } finally {
    Atomics.store(cells, 11, 0);
    for (const ticket of tickets) gate.finish(ticket);
  }
});
