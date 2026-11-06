import { expect, test } from "bun:test";
import { RecordRing, RECORD_RING_HEADER_BYTES, type RingWriter } from "../browser/gpu/ring.js";
import type { RingWorkerRequest } from "./fixtures/gpu/ring-worker.js";

function setup(capacity = 32, header: 8 | 16 = 8) {
  const backing = new SharedArrayBuffer(RECORD_RING_HEADER_BYTES + capacity);
  const ring = new RecordRing(backing, header);
  return { backing, ring, cells: new Int32Array(backing), data: new DataView(backing, 64) };
}

function record(length: number, kind = 17, value = 0x51): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length).fill(value);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, kind, true);
  view.setUint32(4, length, true);
  return bytes;
}

function acquire(ring: RecordRing): RingWriter {
  const result = ring.tryAcquireWriter();
  if (result.kind !== "acquired") throw new Error(`writer is ${result.kind}`);
  return result.writer;
}

function write(ring: RecordRing, bytes: Uint8Array) {
  const writer = acquire(ring);
  try {
    return writer.tryWrite(bytes);
  } finally {
    writer.release();
  }
}

function next(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("GPU ring worker response timed out"));
    }, 3_000);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      cleanup();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message));
    };
  });
}

function request(worker: Worker, message: RingWorkerRequest): Promise<unknown> {
  const response = next(worker);
  worker.postMessage(message);
  return response;
}

async function workers(count: number, run: (owned: readonly Worker[]) => Promise<void>) {
  const owned: Worker[] = [];
  try {
    for (let index = 0; index < count; index++)
      owned.push(new Worker(new URL("./fixtures/gpu/ring-worker.ts", import.meta.url).href));
    await run(owned);
  } finally {
    for (let index = 0; index < owned.length; index++) await owned[index]!.terminate();
  }
}

async function waitValue(waiting: ReturnType<RecordRing["waitAsync"]>): Promise<string> {
  return waiting.async ? await waiting.value : waiting.value;
}

test("fixed supplied backing has the structural 64-byte header and is never reset on attach", () => {
  const { backing, cells, ring } = setup();
  expect(ring.capacity).toBe(32);
  expect(ring.recordHeaderBytes).toBe(8);
  expect(RECORD_RING_HEADER_BYTES).toBe(64);
  expect(write(ring, record(8))).toEqual({ kind: "written" });
  const attached = new RecordRing(backing, 8);
  expect(attached.readInto(new Uint8Array(8))).toEqual({ kind: "record", bytes: 8 });
  expect(cells[0]).toBe(8);
  expect(cells[2]).toBe(8);
  expect(Array.from(cells.slice(5, 16))).toEqual(Array(11).fill(0));
});

test("rejects invalid backing geometry and growable buffers, including already-maximal ones", () => {
  for (const capacity of [0, 1, 7, 12, 24, 40]) expect(() => setup(capacity)).toThrow(RangeError);
  expect(() => setup(8, 16)).toThrow(RangeError);
  expect(() => Reflect.construct(RecordRing, [new SharedArrayBuffer(96), 12])).toThrow(RangeError);
  expect(() => Reflect.construct(RecordRing, [new ArrayBuffer(96), 8])).toThrow();
  for (const maximum of [96, 128]) {
    const growable = new SharedArrayBuffer(96, { maxByteLength: maximum });
    expect(() => new RecordRing(growable, 8)).toThrow("must be fixed");
  }
});

test("the smallest command and completion rings fill exactly and make bounded progress", () => {
  for (const header of [8, 16] as const) {
    const { ring } = setup(header, header);
    const output = new Uint8Array(header);
    expect(ring.readInto(output)).toEqual({ kind: "empty" });
    expect(write(ring, record(header))).toEqual({ kind: "written" });
    expect(write(ring, record(header))).toEqual({ kind: "full" });
    expect(ring.readInto(output)).toEqual({ kind: "record", bytes: header });
    expect(output).toEqual(record(header));
    expect(write(ring, record(header))).toEqual({ kind: "written" });
  }
});

test("source framing rejects reserved padding, oversized, unaligned and inconsistent lengths", () => {
  const { ring, cells } = setup(16);
  const wrongLength = record(16);
  new DataView(wrongLength.buffer).setUint32(4, 8, true);
  for (const bytes of [record(8, 0), record(24), record(9), new Uint8Array(0), wrongLength])
    expect(() => write(ring, bytes)).toThrow(RangeError);
  expect(cells[0]).toBe(0);
  expect(cells[3]).toBe(0);
  expect(() => write(setup(16, 16).ring, record(8))).toThrow(RangeError);
});

test("whole-record copies honor source and destination offsets and do not borrow payload views", () => {
  const { ring } = setup();
  const source = new Uint8Array(40).fill(0xa1);
  source.set(record(16), 8);
  expect(write(ring, source.subarray(8, 24))).toEqual({ kind: "written" });
  source.fill(0);
  const destination = new Uint8Array(40).fill(0xcc);
  expect(ring.readInto(destination.subarray(4, 20))).toEqual({ kind: "record", bytes: 16 });
  expect(destination.subarray(4, 20)).toEqual(record(16));
  expect(destination.subarray(0, 4)).toEqual(new Uint8Array(4).fill(0xcc));
  expect(destination.subarray(20)).toEqual(new Uint8Array(20).fill(0xcc));
  write(ring, record(16, 19, 0x97));
  expect(destination.subarray(4, 20)).toEqual(record(16));
});

test("a short destination does not consume or partially copy a record", () => {
  const { ring, cells } = setup();
  write(ring, record(24));
  const output = new Uint8Array(16).fill(0xcc);
  expect(ring.readInto(output)).toEqual({ kind: "short", required: 24 });
  expect(cells[2]).toBe(0);
  expect(output).toEqual(new Uint8Array(16).fill(0xcc));
  expect(ring.readInto(new Uint8Array(24))).toEqual({ kind: "record", bytes: 24 });
});

test("input and output cannot alias private ring backing", () => {
  const { backing, ring } = setup();
  expect(() => write(ring, new Uint8Array(backing, 64, 8))).toThrow("cannot alias");
  expect(() => ring.readInto(new Uint8Array(backing, 64, 32))).toThrow("cannot alias");
});

test("wrapping completion records use an eight-byte common padding header", () => {
  const { ring, cells, data } = setup(32, 16);
  write(ring, record(24));
  ring.readInto(new Uint8Array(24));
  expect(write(ring, record(16))).toEqual({ kind: "written" });
  expect(data.getUint32(24, true)).toBe(0);
  expect(data.getUint32(28, true)).toBe(8);
  expect(cells[0]).toBe(48);
  const output = new Uint8Array(16);
  expect(ring.readInto(output)).toEqual({ kind: "record", bytes: 16 });
  expect(output).toEqual(record(16));
  expect(cells[2]).toBe(48);
});

test("a ring-sized record publishes padding separately rather than deadlocking an empty ring", () => {
  const { ring, cells } = setup();
  write(ring, record(8));
  ring.readInto(new Uint8Array(8));
  const writer = acquire(ring);
  try {
    expect(writer.tryWrite(record(32))).toEqual({ kind: "full" });
    expect(cells[0]).toBe(32);
    expect(ring.readInto(new Uint8Array(32))).toEqual({ kind: "empty" });
    expect(cells[2]).toBe(32);
    expect(writer.tryWrite(record(32))).toEqual({ kind: "written" });
  } finally {
    writer.release();
  }
  expect(ring.readInto(new Uint8Array(32))).toEqual({ kind: "record", bytes: 32 });
});

test("padding advances with only its own free space and a short output leaves the wrapped record", () => {
  const { ring, cells } = setup();
  write(ring, record(24));
  expect(write(ring, record(16))).toEqual({ kind: "full" });
  expect(cells[0]).toBe(32);
  ring.readInto(new Uint8Array(24));
  expect(ring.readInto(new Uint8Array(0))).toEqual({ kind: "empty" });
  expect(write(ring, record(16))).toEqual({ kind: "written" });
  expect(ring.readInto(new Uint8Array(8))).toEqual({ kind: "short", required: 16 });
  expect(cells[2]).toBe(32);
});

test("checked u32 counters and the wake sequence cross their signed and unsigned rollovers", () => {
  const { ring, cells } = setup();
  Atomics.store(cells, 0, -8);
  Atomics.store(cells, 2, -8);
  Atomics.store(cells, 4, 0x7fffffff);
  const writer = acquire(ring);
  try {
    expect(writer.tryWrite(record(16))).toEqual({ kind: "written" });
    expect(cells[0]).toBe(16);
    expect(ring.sequence()).toBe(-0x80000000);
  } finally {
    writer.release();
  }
  const output = new Uint8Array(16);
  expect(ring.readInto(output)).toEqual({ kind: "record", bytes: 16 });
  expect(cells[2]).toBe(16);
  expect(output).toEqual(record(16));
  Atomics.store(cells, 4, -1);
  ring.terminate(5);
  expect(ring.sequence()).toBe(0);
});

test("counter corruption cannot appear as free space or readable bytes", () => {
  for (const [head, tail] of [
    [1, 0],
    [0, 1],
    [40, 0],
    [0, 8],
    [-8, 0],
  ]) {
    const { ring, cells } = setup();
    Atomics.store(cells, 0, head!);
    Atomics.store(cells, 2, tail!);
    expect(() => write(ring, record(8))).toThrow("counters");
    expect(() => ring.readInto(new Uint8Array(32))).toThrow("counters");
  }
});

test("invalid committed record lengths never copy or consume a partial record", () => {
  for (const length of [0, 4, 7, 9, 24, 32, 0xfffffff8]) {
    const { ring, cells, data } = setup();
    Atomics.store(cells, 0, 16);
    data.setUint32(0, 17, true);
    data.setUint32(4, length, true);
    const output = new Uint8Array(32).fill(0xcc);
    expect(() => ring.readInto(output)).toThrow("length");
    expect(cells[2]).toBe(0);
    expect(output).toEqual(new Uint8Array(32).fill(0xcc));
  }
});

test("rejects crossing records, malformed padding, repeated padding and truncated completions", () => {
  const crossing = setup();
  crossing.cells[2] = 24;
  crossing.cells[0] = 40;
  crossing.data.setUint32(24, 17, true);
  crossing.data.setUint32(28, 16, true);
  expect(() => crossing.ring.readInto(new Uint8Array(32))).toThrow("crosses the end");
  for (const [prefix, length] of [
    [0x10000, 8],
    [0, 16],
  ]) {
    const { ring, cells, data } = setup();
    cells[0] = 16;
    data.setUint32(0, prefix!, true);
    data.setUint32(4, length!, true);
    expect(() => ring.readInto(new Uint8Array(32))).toThrow("padding");
  }
  const repeated = setup();
  repeated.cells[0] = 40;
  repeated.cells[2] = 24;
  repeated.data.setUint32(28, 8, true);
  repeated.data.setUint32(4, 8, true);
  expect(() => repeated.ring.readInto(new Uint8Array(32))).toThrow("consecutive");
  const completion = setup(16, 16);
  completion.cells[0] = 8;
  completion.data.setUint32(0, 17, true);
  completion.data.setUint32(4, 8, true);
  expect(() => completion.ring.readInto(new Uint8Array(16))).toThrow("truncated");
});

test("seeded malformed lengths have bounded, deterministic read outcomes", () => {
  let seed = 0x734ac017;
  for (let index = 0; index < 256; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = seed % 40;
    const { ring, cells, data } = setup();
    cells[0] = 32;
    data.setUint32(0, 17, true);
    data.setUint32(4, length, true);
    if (length > 0 && length <= 32 && length % 8 === 0)
      expect(ring.readInto(new Uint8Array(32))).toEqual({ kind: "record", bytes: length });
    else expect(() => ring.readInto(new Uint8Array(32))).toThrow("length");
  }
});

test("writer leases serialize calls, can span records, release idempotently and reject reuse", () => {
  const { ring } = setup();
  const first = acquire(ring);
  expect(ring.tryAcquireWriter()).toEqual({ kind: "busy" });
  expect(first.tryWrite(record(8, 21))).toEqual({ kind: "written" });
  expect(first.tryWrite(record(8, 22))).toEqual({ kind: "written" });
  first.release();
  const second = acquire(ring);
  first.release();
  expect(ring.tryAcquireWriter()).toEqual({ kind: "busy" });
  expect(() => first.tryWrite(record(8))).toThrow("released");
  second.release();
  const output = new Uint8Array(8);
  ring.readInto(output);
  expect(output).toEqual(record(8, 21));
  ring.readInto(output);
  expect(output).toEqual(record(8, 22));
});

test("invalid writer lock values are corruption, never silently treated as contention", () => {
  const { ring, cells } = setup();
  cells[3] = 7;
  expect(() => ring.tryAcquireWriter()).toThrow("writer lock");
});

test("terminal reasons are immutable u32 values, wake full rings and preserve committed replies", () => {
  const { ring } = setup(16, 16);
  const writer = acquire(ring);
  expect(writer.tryWrite(record(16))).toEqual({ kind: "written" });
  const seen = ring.sequence();
  expect(ring.terminate(0xffffffff)).toEqual({ kind: "terminal", reason: 0xffffffff });
  expect(ring.sequence()).not.toBe(seen);
  expect(ring.terminate(6)).toEqual({ kind: "terminal", reason: 0xffffffff });
  expect(writer.tryWrite(record(16))).toEqual({ kind: "terminal", reason: 0xffffffff });
  expect(ring.readInto(new Uint8Array(8))).toEqual({ kind: "short", required: 16 });
  expect(ring.readInto(new Uint8Array(16))).toEqual({ kind: "record", bytes: 16 });
  expect(ring.readInto(new Uint8Array(16))).toEqual({ kind: "terminal", reason: 0xffffffff });
  writer.release();
  expect(ring.tryAcquireWriter()).toEqual({ kind: "terminal", reason: 0xffffffff });
  for (const reason of [0, -1, 0x100000000, 1.5, NaN])
    expect(() => ring.terminate(reason)).toThrow(RangeError);
});

test("wait samples prevent lost publication, consumption, lock-release and terminal wakes", async () => {
  const { ring } = setup(16);
  const before = ring.sequence();
  write(ring, record(16));
  expect(ring.wait(before, Infinity, () => {})).toBe("not-equal");
  const waitingRead = ring.waitAsync(ring.sequence(), Infinity);
  ring.readInto(new Uint8Array(16));
  expect(await waitValue(waitingRead)).toBe("ok");
  const writer = acquire(ring);
  const waitingLock = ring.waitAsync(ring.sequence(), Infinity);
  writer.release();
  expect(await waitValue(waitingLock)).toBe("ok");
  const waitingClose = ring.waitAsync(ring.sequence(), Infinity);
  ring.terminate(8);
  expect(await waitValue(waitingClose)).toBe("ok");
  expect(ring.wait(ring.sequence(), Infinity, () => {})).toBe("terminal");
  expect(await waitValue(ring.waitAsync(ring.sequence(), Infinity))).toBe("terminal");
});

test("infinite waits are bounded slices and run liveness checks before and after sleeping", () => {
  const { ring } = setup();
  let checks = 0;
  const started = performance.now();
  expect(() =>
    ring.wait(ring.sequence(), Infinity, () => {
      checks++;
      if (checks === 2) throw new Error("producer interrupted");
    }),
  ).toThrow("producer interrupted");
  expect(checks).toBe(2);
  expect(performance.now() - started).toBeLessThan(250);
  let called = false;
  expect(() =>
    ring.wait(ring.sequence(), Infinity, () => {
      called = true;
      throw new Error("already interrupted");
    }),
  ).toThrow("already interrupted");
  expect(called).toBe(true);
  expect(ring.wait(ring.sequence(), 0, () => {})).toBe("timed-out");
  for (const timeout of [-1, NaN]) {
    expect(() => ring.wait(0, timeout, () => {})).toThrow(RangeError);
    expect(() => ring.waitAsync(0, timeout)).toThrow(RangeError);
  }
  expect(() => ring.wait(0x100000000, 0, () => {})).toThrow(RangeError);
});

test("two actual Bun Workers publish in deterministic lease order", async () => {
  await workers(2, async (owned) => {
    const { ring, backing } = setup(64);
    const first = owned[0]!;
    const second = owned[1]!;
    expect(await request(first, { action: "hold", backing })).toBe("held");
    expect(await request(second, { action: "write", backing, record: record(16, 22) })).toEqual({
      kind: "busy",
    });
    expect(await request(first, { action: "write-held", record: record(16, 21) })).toEqual({
      kind: "written",
    });
    expect(await request(first, { action: "release" })).toBe("released");
    expect(await request(second, { action: "write", backing, record: record(16, 22) })).toEqual({
      kind: "written",
    });
    const output = new Uint8Array(16);
    ring.readInto(output);
    expect(output).toEqual(record(16, 21));
    ring.readInto(output);
    expect(output).toEqual(record(16, 22));
  });
});

test("copied but unpublished bytes stay invisible and terminal state atomically fences commit", async () => {
  await workers(1, async (owned) => {
    const { ring, backing, cells } = setup(64);
    write(ring, record(16, 21));
    const gate = new SharedArrayBuffer(8);
    const control = new Int32Array(gate);
    const worker = owned[0]!;
    expect(await request(worker, { action: "pause", backing, gate, record: record(16, 22) })).toBe(
      "copy-ready",
    );
    expect(cells[0]).toBe(16);
    const output = new Uint8Array(16);
    expect(ring.readInto(output)).toEqual({ kind: "record", bytes: 16 });
    expect(output).toEqual(record(16, 21));
    expect(ring.readInto(output)).toEqual({ kind: "empty" });
    ring.terminate(48);
    const resumed = next(worker);
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
    expect(await resumed).toEqual({ kind: "terminal", reason: 48 });
    expect(cells[0]).toBe(16);
    expect(ring.readInto(output)).toEqual({ kind: "terminal", reason: 48 });
  });
});

test("physically interrupted producers cannot expose a partial record or prevent terminal wake", async () => {
  await workers(1, async (owned) => {
    const { ring, backing, cells } = setup(64);
    const worker = owned[0]!;
    const gate = new SharedArrayBuffer(8);
    expect(await request(worker, { action: "pause", backing, gate, record: record(32) })).toBe(
      "copy-ready",
    );
    await worker.terminate();
    expect(cells[3]).toBe(1);
    expect(ring.tryAcquireWriter()).toEqual({ kind: "busy" });
    expect(ring.readInto(new Uint8Array(64))).toEqual({ kind: "empty" });
    const before = ring.sequence();
    ring.terminate(71);
    expect(cells[0]).toBe(0);
    expect(ring.wait(before, Infinity, () => {})).toBe("terminal");
  });
});

test("captured operations retain no path through guest-replaced natives", async () => {
  await workers(1, async (owned) => {
    const { backing } = setup(32, 16);
    expect(await request(owned[0]!, { action: "authority", backing })).toEqual({
      written: { kind: "written" },
      read: { kind: "record", bytes: 16 },
      byte: 71,
      checks: 2,
      before: 1,
      after: 1,
      terminal: { kind: "terminal", reason: 73 },
    });
  });
});

test("empty and padding-only reads cannot report terminal ahead of a racing committed record", async () => {
  for (const padding of [false, true]) await readerTerminalRace(padding);
});

async function readerTerminalRace(padding: boolean): Promise<void> {
  await workers(1, async (owned) => {
    const { backing, ring } = setup(64);
    if (padding) {
      write(ring, record(8));
      ring.readInto(new Uint8Array(8));
      expect(write(ring, record(64))).toEqual({ kind: "full" });
    }
    const worker = owned[0]!;
    const gate = new SharedArrayBuffer(8);
    const control = new Int32Array(gate);
    expect(await request(worker, { action: "pause-read", backing, gate })).toBe("read-ready");
    // In the padding case, the reader has not consumed padding yet. A short
    // ordinary record still fits before it does so.
    expect(write(ring, record(8, 23))).toEqual({ kind: "written" });
    ring.terminate(37);
    const resumed = next(worker);
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
    expect(await resumed).toEqual({ kind: "empty" });
    const output = new Uint8Array(8);
    expect(ring.readInto(output)).toEqual({ kind: "record", bytes: 8 });
    expect(output).toEqual(record(8, 23));
    expect(ring.readInto(output)).toEqual({ kind: "terminal", reason: 37 });
  });
}
