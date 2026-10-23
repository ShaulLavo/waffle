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

import { retainedClientFixture } from "./fixtures/retained-client";
import { MissingSegmentError } from "../fs/shared";
import { DirtyCapacityError } from "../fs/dirty-admission";
import type { WriteTicket } from "../fs/write-barrier";

test("ordinary direct writes verify once at execution, including nested ownership", () => {
  const { client, cleanup } = retainedClientFixture();
  const gate = client.shared.writeAdmission;
  const verify = gate.verify.bind(gate);
  let checks = 0;
  gate.verify = (...args) => {
    checks++;
    return verify(...args);
  };
  try {
    expect(client.write(0, [new Uint8Array([90])], 0)).toBe(1);
    expect(checks).toBe(1);
    expect(gate.active).toBe(0);
    client.withMutation(() => {
      checks = 0;
      expect(client.write(0, [new Uint8Array([89])], 0)).toBe(1);
      expect(checks).toBe(1);
      expect(gate.active).toBe(1);
    });
    expect(gate.active).toBe(0);
  } finally {
    cleanup();
  }
});

for (const event of ["stop", "reap"] as const) {
  test(`late ${event} before direct execution cannot change bytes or epoch`, () => {
    const { client, cleanup } = retainedClientFixture();
    const gate = client.shared.writeAdmission;
    const direct = client.shared.directWrite.bind(client.shared);
    const before = client.shared.snapshot(0);
    const epoch = new Int32Array(client.connection.epoch);
    const observed = Atomics.load(epoch, 0);
    client.shared.directWrite = (...args) => {
      if (event === "stop") gate.stop();
      else gate.reapLocal(client.connection.owner);
      return direct(...args);
    };
    try {
      expect(client.write(0, [new Uint8Array([90])], 0)).toBe(-11);
      expect(client.shared.snapshot(0)).toEqual(before);
      expect(Atomics.load(epoch, 0)).toBe(observed);
      expect(gate.active).toBe(0);
    } finally {
      cleanup();
    }
  });
}

function directTicket(client: ReturnType<typeof retainedClientFixture>["client"], ticket: WriteTicket) {
  return client.shared.directWrite(
    client.shared.fileSlot(0), 0, [new Uint8Array([90])], 0, 1,
    new Int32Array(client.connection.epoch), () => false, client.connection.owner,
    false, undefined, ticket,
  );
}

test("explicit execution rejects malformed, wrong-owner and full-generation aliases", () => {
  const { client, cleanup } = retainedClientFixture();
  const gate = client.shared.writeAdmission;
  const stale = gate.admit(client.connection.owner);
  gate.finish(stale);
  const cells = new Int32Array(gate.buffer, WRITE_BARRIER_OFFSET);
  Atomics.store(cells, 2, 0x7fffffff);
  const ticket = gate.admit(client.connection.owner);
  const before = client.shared.snapshot(0);
  const epoch = new Int32Array(client.connection.epoch);
  const observed = Atomics.load(epoch, 0);
  const invalid = [
    stale,
    { ...ticket, slot: ticket.slot + 1 },
    { ...ticket, slot: -1 },
    { ...ticket, slot: 10.5 },
    { ...ticket, slot: Infinity },
    { ...ticket, slot: cells.length },
    { ...ticket, owner: ticket.owner + 1 },
    { ...ticket, serial: ticket.serial + 0.5 },
    { ...ticket, serial: Number.MAX_SAFE_INTEGER + 1 },
    { ...ticket, serial: ticket.serial + 0x80000000 },
  ];
  try {
    expect(ticket.slot).toBe(stale.slot);
    expect(ticket.serial % 0x80000000).toBe(stale.serial);
    for (const rejected of invalid) expect(() => directTicket(client, rejected)).toThrow();
    expect(client.shared.snapshot(0)).toEqual(before);
    expect(Atomics.load(epoch, 0)).toBe(observed);
    expect(gate.active).toBe(1);
    expect(directTicket(client, { ...ticket })).toBe(1);
    gate.finish(ticket);
    expect(() => directTicket(client, ticket)).toThrow();
    expect(gate.active).toBe(0);
  } finally {
    gate.finish(ticket);
    cleanup();
  }
});

for (const retry of ["grow", "dirtyWait"] as const) {
  test(`${retry} keeps the same actual ticket and rechecks late stop`, () => {
    const { client, cleanup } = retainedClientFixture();
    const gate = client.shared.writeAdmission;
    const direct = client.shared.directWrite.bind(client.shared);
    const before = client.shared.snapshot(0);
    let attempts = 0;
    let waits = 0;
    client.shared.directWrite = (...args) => {
      attempts++;
      if (attempts > 1) return direct(...args);
      if (retry === "dirtyWait") throw new DirtyCapacityError();
      return undefined;
    };
    client.call = (operation) => {
      expect(operation).toBe(retry);
      expect(gate.active).toBe(1);
      waits++;
      gate.stop();
    };
    try {
      expect(client.write(0, [new Uint8Array([90])], 0)).toBe(-11);
      expect(attempts).toBe(2);
      expect(waits).toBe(1);
      expect(gate.active).toBe(0);
      expect(client.shared.snapshot(0)).toEqual(before);
    } finally {
      cleanup();
    }
  });
}

test("copied fallback cancellation and aborted observation retain received execution debt", async () => {
  const { client, cleanup } = retainedClientFixture();
  const gate = client.shared.writeAdmission;
  let completion: ReturnType<typeof client.prepare> | undefined;
  let ticket: WriteTicket | undefined;
  client.shared.directWrite = () => { throw new MissingSegmentError(); };
  client.call = (operation, args, data) => {
    expect(operation).toBe("write");
    completion = client.prepare(operation, args, data);
    ticket = completion.writeTicket;
    if (!ticket) throw new Error("missing fallback ticket");
    gate.receive(ticket, client.connection.owner, completion.id, false);
    completion.posted = true;
    return data?.length;
  };
  try {
    expect(client.write(0, [new Uint8Array([90])], 0)).toBe(1);
    if (!completion || !ticket) throw new Error("missing received execution");
    const pending = completion;
    const held = ticket;
    expect(gate.active).toBe(1);
    expect(gate.inputBytes).toBe(2);
    const lease = gate.close();
    const signal = new AbortController();
    const drained = gate.drain(lease, signal.signal);
    pending.cancel();
    gate.reapLocal(client.connection.owner);
    gate.discardUnreceived(client.connection.owner);
    expect(gate.active).toBe(1);
    signal.abort();
    await expect(drained).rejects.toMatchObject({ errno: 11 });
    expect(gate.active).toBe(1);
    gate.verify(held);
    gate.finish(held, -pending.id);
    expect(gate.active).toBe(0);
    expect(gate.inputBytes).toBe(0);
    expect(gate.metadataBytes).toBe(0);
  } finally {
    if (completion && ticket) gate.finish(ticket, -completion.id);
    completion?.release();
    cleanup();
  }
});
