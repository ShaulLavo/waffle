import { describe, expect, test } from "bun:test";
import { GPU_LIMITS, GPU_TERMINAL, ServiceCredit } from "../browser/gpu/protocol.ts";
import { GpuConnection } from "../browser/gpu/scheduler.ts";
import { RecordRing } from "../browser/gpu/ring.ts";
import { LogicalAppend, LogicalReader } from "../browser/gpu/transport.ts";
import { decodeCall } from "../browser/gpu/codec.ts";
import {
  command,
  handle,
  joinRecords,
  ring,
  ROOT,
  words,
  RecordingTarget,
  rig,
  send,
  workerRequest,
} from "./fixtures/gpu/core-fixture.ts";

function write(ring: RecordRing, bytes: Uint8Array): void {
  const acquired = ring.tryAcquireWriter();
  if (acquired.kind !== "acquired") throw new Error("Ring writer unavailable");
  try {
    expect(acquired.writer.tryWrite(bytes).kind).toBe("written");
  } finally {
    acquired.writer.release();
  }
}
function chunk(
  total: number,
  offset: number,
  payload: Uint8Array,
  flags: number,
  reserved = 0,
): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((24 + payload.length) / 8) * 8);
  bytes.set(words(0x1004, [total, offset, payload.length, reserved], flags));
  new DataView(bytes.buffer).setUint32(4, bytes.length, true);
  bytes.set(payload, 24);
  return bytes;
}
function largeCommand(labelLength = 2048): Uint8Array {
  return command("device.create_command_encoder", {
    result: handle(9),
    receiver: handle(3),
    descriptor: { next_in_chain: [], label: "x".repeat(labelLength) },
  });
}

function consumeRecord(read: ReturnType<LogicalReader["read"]>, source: Uint8Array): number {
  if (read.kind !== "record") return 0;
  try {
    expect(read.record.bytes).toEqual(source);
    expect(decodeCall(read.record.bytes).layout.name).toBe("device.create_command_encoder");
  } finally {
    read.record.release();
  }
  return 1;
}

describe("logical GPU transport over the real RecordRing", () => {
  test("large logical publication progresses incrementally through a tiny full ring while holding its lease", () => {
    const commands = ring(64);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(commands, credit);
    const source = largeCommand();
    const append = new LogicalAppend(commands, source);
    let records = 0;
    let steps = 0;
    try {
      expect(append.advance()).toBe("full");
      expect(commands.tryAcquireWriter().kind).toBe("busy");
      for (; steps < 10000; steps++) {
        const read = reader.read();
        records += consumeRecord(read, source);
        const progress = append.advance();
        if (progress === "done" && records) break;
      }
      expect(records).toBe(1);
      expect(steps).toBeGreaterThan(100);
      const acquired = commands.tryAcquireWriter();
      expect(acquired.kind).toBe("acquired");
      if (acquired.kind === "acquired") acquired.writer.release();
    } finally {
      reader.dispose();
      append.cancel();
    }
    expect(credit.used).toBe(0);
  });
  test("wraps chunks and u32 counters without changing the ring header layout", () => {
    const backing = new SharedArrayBuffer(64 + 128);
    const publication = new BigInt64Array(backing, 0, 1);
    const cells = new Int32Array(backing, 0, 16);
    Atomics.store(publication, 0, 0xfffffff8n);
    Atomics.store(cells, 2, -8);
    const commands = new RecordRing(backing, 8);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(commands, credit);
    const source = largeCommand(1024);
    const append = new LogicalAppend(commands, source);
    let output: Uint8Array | undefined;
    try {
      for (let steps = 0; steps < 1000; steps++) {
        append.advance();
        const result = reader.read();
        if (result.kind !== "record") continue;
        output = result.record.bytes.slice();
        result.record.release();
        break;
      }
      expect(output).toEqual(source);
      expect(Number(Atomics.load(publication, 0) & 0xffffffffn)).toBeLessThan(0xfffffff8);
    } finally {
      reader.dispose();
      append.cancel();
    }
    expect(credit.used).toBe(0);
  });
  test("validates the entire append span before any earlier record can publish", () => {
    const commands = ring(128);
    const valid = command("instance.request_adapter", {
      result: handle(2),
      token: 1,
      receiver: ROOT,
      options: null,
    });
    const invalid = joinRecords(valid, new Uint8Array([1, 2, 3]));
    expect(() => new LogicalAppend(commands, invalid)).toThrow("Truncated");
    expect(commands.readInto(new Uint8Array(128)).kind).toBe("empty");
    expect(() => new LogicalAppend(commands, chunk(8, 0, words(1, []), 2))).toThrow("opcode");
  });
  test("bounds logical size and reserves service memory before allocation", () => {
    const commands = ring(128);
    expect(() => new LogicalAppend(commands, largeCommand(), 128)).toThrow("limit");
    const credit = new ServiceCredit(128 + 512);
    const reader = new LogicalReader(commands, credit);
    try {
      write(commands, chunk(1024, 0, words(1, []), 1));
      expect(reader.read()).toEqual({ kind: "terminal", reason: GPU_TERMINAL.resource });
      expect(credit.used).toBe(0);
    } finally {
      reader.dispose();
    }
    expect(GPU_LIMITS.logicalBytes).toBe(16 * 1024 * 1024);
    expect(GPU_LIMITS.serviceBytes).toBe(64 * 1024 * 1024);
  });
  test("rejects deterministic malformed chunk envelopes locally", () => {
    const original = words(0x1001, [9, 1, 0]);
    const cases = [
      chunk(24, 8, original.subarray(0, 8), 1),
      chunk(24, 0, new Uint8Array(0), 1),
      chunk(24, 0, original, 1),
      chunk(24, 0, original.subarray(0, 8), 2),
      chunk(24, 0, original.subarray(0, 8), 3),
      chunk(24, 0, original.subarray(0, 8), 1, 1),
      chunk(23, 0, original.subarray(0, 8), 1),
      chunk(24, 0, chunk(8, 0, words(1, []), 2), 2),
    ];
    for (const malformed of cases) {
      const commands = ring(256);
      const credit = new ServiceCredit();
      const reader = new LogicalReader(commands, credit);
      try {
        write(commands, malformed);
        expect(() => reader.read()).not.toThrow();
        expect(commands.terminal()?.reason).toBe(GPU_TERMINAL.protocol);
      } finally {
        reader.dispose();
      }
      expect(credit.used).toBe(0);
    }
  });
  test("rejects gaps, overlap, changed totals, interleaving and nested envelopes", () => {
    const source = largeCommand(16);
    const first = chunk(source.length, 0, source.subarray(0, 8), 1);
    const following = [
      chunk(source.length, 0, source.subarray(8, 16), 1),
      chunk(source.length, 16, source.subarray(8, 16), 1),
      chunk(source.length + 8, 8, source.subarray(8, 16), 1),
      words(0x1000, [1, 2, 1]),
    ];
    for (const bad of following) {
      const commands = ring(256);
      const credit = new ServiceCredit();
      const reader = new LogicalReader(commands, credit);
      try {
        write(commands, first);
        expect(reader.read().kind).toBe("progress");
        write(commands, bad);
        expect(reader.read()).toEqual({ kind: "terminal", reason: GPU_TERMINAL.protocol });
      } finally {
        reader.dispose();
      }
      expect(credit.used).toBe(0);
    }
    const commands = ring(128);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(commands, credit);
    try {
      const inner = words(0x1004, [8, 0, 0, 0]);
      write(commands, chunk(inner.length, 0, inner, 2));
      expect(reader.read().kind).toBe("terminal");
    } finally {
      reader.dispose();
    }
  });
  test("close or kill during assembly cancels missing final chunks, releases memory and fences a held writer", () => {
    for (const reason of [GPU_TERMINAL.closed, GPU_TERMINAL.revoked]) {
      const commands = ring(64);
      const credit = new ServiceCredit();
      const reader = new LogicalReader(commands, credit);
      const append = new LogicalAppend(commands, largeCommand());
      try {
        append.advance();
        expect(reader.read().kind).toBe("progress");
        expect(reader.assembling).toBe(true);
        commands.terminate(reason);
        // Previously committed chunks still drain, but they can never become a logical record.
        for (let step = 0; step < 8; step++) reader.read();
        expect(append.advance()).toBe("terminal");
        expect(commands.terminal()?.reason).toBe(reason);
      } finally {
        reader.dispose();
        append.cancel();
      }
      expect(credit.used).toBe(0);
    }
  });
  test("seeded mutations never escape the decoder or terminate a different connection", () => {
    let seed = 0x71a4c3d2;
    const good = rig(new RecordingTarget());
    try {
      for (let index = 0; index < 100; index++) {
        const isolated = rig(new RecordingTarget());
        const bytes = command("instance.request_adapter", {
          result: handle(2),
          token: 1,
          receiver: ROOT,
          options: null,
        });
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const at = 8 + (seed % (bytes.length - 8));
        bytes[at] = (bytes[at] ?? 0) ^ (1 << (seed % 8));
        try {
          expect(() => send(isolated.connection, bytes)).not.toThrow();
        } finally {
          isolated.connection.close();
        }
        expect(isolated.credit.used).toBe(0);
        expect(good.connection.state.kind).toBe("ready");
      }
    } finally {
      good.connection.close();
    }
  });
  test("physically terminating an append worker never steals its held logical publication lease", async () => {
    const backing = new SharedArrayBuffer(64 + 128);
    const commands = new RecordRing(backing, 8);
    const credit = new ServiceCredit();
    const reader = new LogicalReader(commands, credit);
    const worker = new Worker(
      new URL("./fixtures/gpu/core-transport-worker.ts", import.meta.url).href,
    );
    try {
      expect(await workerRequest(worker, { action: "hold", backing })).toEqual({
        kind: "full",
        locked: "busy",
      });
      expect(reader.read().kind).toBe("progress");
      await worker.terminate();
      expect(commands.tryAcquireWriter().kind).toBe("busy");
      commands.terminate(GPU_TERMINAL.revoked);
      for (let turn = 0; turn < 8; turn++) reader.read();
      expect(credit.used).toBe(0);
      expect(commands.tryAcquireWriter()).toEqual({
        kind: "terminal",
        reason: GPU_TERMINAL.revoked,
      });
    } finally {
      await worker.terminate();
      reader.dispose();
    }
  });
  test("the guest publication path never exposes ring or chunk buffers through replaced native copies and getters", async () => {
    const worker = new Worker(
      new URL("./fixtures/gpu/core-transport-worker.ts", import.meta.url).href,
    );
    try {
      expect(
        await workerRequest(worker, {
          action: "authority",
          backing: new SharedArrayBuffer(64 + 128),
        }),
      ).toEqual({ positive: 1, hits: 0 });
    } finally {
      await worker.terminate();
    }
  });
  test("a failed core-owner setup releases its already reserved service scratch", () => {
    const credit = new ServiceCredit();
    expect(
      () =>
        new GpuConnection(ring(128), ring(256, 16), new RecordingTarget(), credit, { handles: 1 }),
    ).toThrow("handle limit");
    expect(credit.used).toBe(0);
  });
});
