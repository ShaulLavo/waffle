import { expect, spyOn, test } from "bun:test";
import { FencedCommandReader } from "../browser/gpu/command-reader.js";
import { ConnectionAccess } from "../browser/gpu/access.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { LogicalReader } from "../browser/gpu/transport.js";
import { GPU_TERMINAL, ServiceCredit } from "../browser/gpu/protocol.js";
import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { words } from "./fixtures/gpu/core-fixture.js";

for (const reason of Object.values(GPU_TERMINAL))
  test(`retired logical reader retains observed terminal ${reason} without querying old transport`, () => {
    const backing = new SharedArrayBuffer(320);
    const ring = new RecordRing(backing, 8);
    const access = new ConnectionAccess(serviceAccess(), () => {});
    const fenced = new FencedCommandReader(ring, access);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(fenced, credit);
    ring.terminate(reason);
    expect(reader.read()).toEqual({ kind: "terminal", reason });
    expect(credit.used).toBe(0);
    const terminal = spyOn(fenced, "terminal");
    try {
      access.seal();
      const frozen = Array.from(new Uint8Array(backing));
      expect(reader.read()).toEqual({ kind: "terminal", reason });
      expect(reader.read()).toEqual({ kind: "terminal", reason });
      expect(terminal).not.toHaveBeenCalled();
      expect(Array.from(new Uint8Array(backing))).toEqual(frozen);
      expect(reader.lastReadBytes).toBe(0);
    } finally {
      terminal.mockRestore();
      reader.dispose();
    }
  });

test("original malformed-chunk reader preserves protocol terminal through grant sealing", () => {
  const backing = new SharedArrayBuffer(320);
  const ring = new RecordRing(backing, 8);
  const access = new ConnectionAccess(serviceAccess(), () => {});
  const credit = new ServiceCredit();
  const reader = new LogicalReader(new FencedCommandReader(ring, access), credit);
  const writer = ring.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer unavailable");
  try {
    expect(writer.writer.tryWrite(words(0x1004, [8, 0, 8, 0, 0, 0])).kind).toBe("written");
  } finally {
    writer.writer.release();
  }
  try {
    expect(reader.read()).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    expect(ring.terminal()?.reason).toBe(GPU_TERMINAL.protocol);
    access.seal();
    const frozen = Array.from(new Uint8Array(backing));
    expect(reader.read()).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    expect(reader.lastReadBytes).toBe(0);
    expect(Array.from(new Uint8Array(backing))).toEqual(frozen);
    expect(credit.used).toBe(0);
  } finally {
    reader.dispose();
  }
});
