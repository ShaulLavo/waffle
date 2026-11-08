import { expect, spyOn, test } from "bun:test";
import { FencedCommandReader } from "../browser/gpu/command-reader.js";
import { ConnectionAccess } from "../browser/gpu/access.js";
import { CompletionOwner } from "../browser/gpu/completions.js";
import { GpuService } from "../browser/gpu/service.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { LogicalReader } from "../browser/gpu/transport.js";
import { GPU_TERMINAL, ServiceCredit } from "../browser/gpu/protocol.js";
import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { ring, words } from "./fixtures/gpu/core-fixture.js";

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

for (const opcode of [0xffff, 0x1002])
  test(`real replay retirement hands its selected terminal to the original reader (${opcode})`, async () => {
    const readers = new Set<LogicalReader>();
    const observed: string[] = [];
    const read = LogicalReader.prototype.read;
    const observer = spyOn(LogicalReader.prototype, "read").mockImplementation(function (
      this: LogicalReader,
    ) {
      readers.add(this);
      const result = read.call(this);
      observed.push(result.kind);
      return result;
    });
    const retired = Promise.withResolvers<void>();
    const service = new GpuService(
      (message) => {
        if (message.type === "retired" && message.grant === 1) retired.resolve();
      },
      { access: serviceAccess(), root: {} },
    );
    const open = {
      type: "open",
      id: 1,
      control: new SharedArrayBuffer(64),
      commands: new SharedArrayBuffer(4160),
      replies: new SharedArrayBuffer(4160),
      arena: new SharedArrayBuffer(gpuPayloadLayout.byteLength),
    } as const;
    try {
      service.receive({ type: "open", grant: 1, open, surfaces: [] });
      const commands = new RecordRing(open.commands, 8);
      const writer = commands.tryAcquireWriter();
      if (writer.kind !== "acquired") throw new Error("writer unavailable");
      try {
        expect(writer.writer.tryWrite(words(opcode, [])).kind).toBe("written");
      } finally {
        writer.writer.release();
      }
      // Replay selects protocol termination before a logical terminal read can occur.
      for (let turn = 0; turn < 20 && commands.terminal()?.reason !== GPU_TERMINAL.protocol; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commands.terminal()?.reason).toBe(GPU_TERMINAL.protocol);
      service.receive({ type: "revoke", grant: 1 });
      await retired.promise;
      expect(readers.size).toBe(1);
      expect(observed).toContain("record");
      expect(observed).not.toContain("terminal");
      expect(service.snapshot()).toMatchObject({ connections: 0, devicesLive: 0, heapBytes: 0 });
      const reader = Array.from(readers)[0]!;
      const buffers = [open.commands, open.replies, open.arena];
      const frozen = buffers.map((buffer) => Array.from(new Uint8Array(buffer)));
      const physical = spyOn(reader.ring, "readInto");
      const terminal = spyOn(reader.ring, "terminal");
      try {
        expect(reader.read()).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
        expect(reader.lastReadBytes).toBe(0);
        expect(physical).not.toHaveBeenCalled();
        expect(terminal).not.toHaveBeenCalled();
        expect(buffers.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual(frozen);
      } finally {
        physical.mockRestore();
        terminal.mockRestore();
      }
    } finally {
      await service.dispose();
      observer.mockRestore();
    }
  });

test("completion retirement callback carries the actual first terminal winner", () => {
  const commands = ring(256);
  const owner = new CompletionOwner({ access: serviceAccess(), commands, replies: ring(256, 16) });
  const received: number[] = [];
  owner.onRetire((reason) => received.push(reason));
  commands.terminate(GPU_TERMINAL.protocol);
  owner.finishRetirement(GPU_TERMINAL.resource);
  owner.onRetire((reason) => received.push(reason));
  expect(received).toEqual([GPU_TERMINAL.protocol, GPU_TERMINAL.protocol]);
  owner.abandon();
  owner.finishRetirement(GPU_TERMINAL.service);
  expect(received).toHaveLength(2);
});

test("abandonment keeps a previously selected local terminal without reading closed transport", () => {
  const commands = ring(256);
  const owner = new CompletionOwner({
    access: serviceAccess(),
    commands,
    replies: ring(256, 16),
    requestRetirement() {},
  });
  const received: number[] = [];
  owner.onRetire((reason) => received.push(reason));
  owner.terminate(GPU_TERMINAL.protocol);
  const terminal = spyOn(commands, "terminal").mockImplementation(() => {
    throw new Error("closed transport read");
  });
  try {
    owner.abandon();
    expect(received).toEqual([GPU_TERMINAL.protocol]);
    expect(owner.state).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
    expect(terminal).not.toHaveBeenCalled();
  } finally {
    terminal.mockRestore();
  }
});
