import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { WriteAdmission, WRITE_BARRIER_OFFSET } from "../fs/write-barrier";
import { withLateBigintHooks } from "./fixtures/bigint-hooks";

function ledger() {
  const buffer = SharedFilesystemState.createBuffer();
  return {
    gate: new WriteAdmission(buffer),
    peer: new WriteAdmission(buffer),
    cells: new Int32Array(buffer, WRITE_BARRIER_OFFSET),
  };
}

test("verified local stamps reject stale reuse with the same low serial word", () => {
  const { gate, peer, cells } = ledger();
  const stale = gate.admit(7);
  gate.verify(stale);
  gate.finish(stale);
  Atomics.store(cells, 2, 0x7fffffff);
  const current = gate.admit(7);
  expect(current.slot).toBe(stale.slot);
  expect(current.serial % 0x80000000).toBe(stale.serial);
  gate.verify(current);
  expect(() => gate.verify(stale)).toThrow();
  expect(() => peer.verify(stale)).toThrow();
  gate.finish(stale);
  expect(gate.active).toBe(1);
  peer.verify({ ...current });
  gate.finish(current);
  expect(() => gate.verify(current)).toThrow();
});

test("local verification never substitutes for received execution ownership", async () => {
  const { gate, peer } = ledger();
  const ticket = gate.admit(7, 16, undefined, 32);
  gate.verify(ticket);
  gate.send(ticket, 9);
  peer.receive({ ...ticket }, 7, 9, false);
  const lease = gate.close();
  const draining = gate.drain(lease);
  let drained = false;
  void draining.then(() => (drained = true));
  gate.reapLocal(7);
  gate.discardUnreceived(7);
  gate.finish(ticket);
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(gate.active).toBe(1);
  expect(gate.inputBytes).toBe(16);
  expect(gate.metadataBytes).toBe(32);
  peer.verify(ticket);
  peer.finish(ticket, -9);
  await draining;
  expect(gate.active).toBe(0);
  gate.open(lease);
});

test("interleaved and cloned tickets verify their own full generation", () => {
  const { gate, peer } = ledger();
  const first = gate.admit(7);
  const second = gate.admit(8);
  gate.verify(first);
  gate.verify(second);
  peer.verify({ ...first });
  expect(() => gate.verify({ ...second, serial: first.serial })).toThrow();
  expect(() => gate.verify(second, 7)).toThrow();
  gate.finish(first);
  peer.verify(second);
  gate.stop();
  expect(() => gate.verify(second)).toThrow();
  gate.verify(second, 8, true);
  gate.finish(second);
  expect(gate.active).toBe(0);
});

test("full generation comparison preserves the safe-integer bound", () => {
  const { gate, peer, cells } = ledger();
  Atomics.store(cells, 2, 0x7ffffffd);
  Atomics.store(cells, 6, 0x3fffff);
  const before = gate.admit(7);
  const last = gate.admit(7);
  expect(last.serial).toBe(Number.MAX_SAFE_INTEGER);
  gate.verify(before);
  gate.verify(last);
  peer.verify({ ...last });
  expect(() => gate.admit(7)).toThrow();
  gate.finish(before);
  gate.finish(last);
  expect(gate.active).toBe(0);
});

test("a retirement changes the observed sequence before a waiter registers", async () => {
  const { gate } = ledger();
  const ticket = gate.admit(7);
  const lease = gate.close();
  const observed = gate.change;
  gate.finish(ticket);
  expect(gate.change).not.toBe(observed);
  await gate.drain(lease);
  gate.open(lease);
});

test("repeated local verification and remote fallback invoke no late bigint hooks", () => {
  const { gate, peer } = ledger();
  const result = withLateBigintHooks(() => {
    const ticket = gate.admit(7);
    gate.verify(ticket);
    gate.verify(ticket);
    gate.send(ticket, 1);
    peer.receive(ticket, 7, 1, false);
    gate.verify(ticket);
    gate.finish(ticket);
    peer.verify(ticket);
    peer.finish(ticket, -1);
  });
  expect(result.calls).toBe(0);
  expect(gate.active).toBe(0);
});

test("a failed local execution still poisons its held cut", async () => {
  const { gate } = ledger();
  const ticket = gate.admit(7);
  gate.verify(ticket);
  const lease = gate.close();
  gate.finish(ticket, 0, true);
  expect(gate.active).toBe(0);
  await expect(gate.drain(lease)).rejects.toThrow("earlier mutation failed");
  gate.open(lease);
});
