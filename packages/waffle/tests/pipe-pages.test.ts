import { afterEach, expect, test } from "bun:test";
import {
  PipeController,
  PipeErrno,
  pipeReservationBytes,
  pipeSharedPagesInUse,
  type PipeEndpoint,
} from "../proc/pipes.js";

const controllers: PipeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});
function controller(options: ConstructorParameters<typeof PipeController>[0] = {}) {
  const pipe = new PipeController({ relay: "manual", ...options });
  controllers.push(pipe);
  return pipe;
}
/** Deterministic xorshift, so a failure reproduces from its seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}
/** Each byte names its writer (top two bits) and that writer's byte counter (low six). */
class Streams {
  private readonly written: number[];
  private readonly read: number[];
  constructor(writers: number) {
    this.written = Array.from({ length: writers }, () => 0);
    this.read = Array.from({ length: writers }, () => 0);
  }
  payload(writer: number, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++)
      bytes[index] = (writer << 6) | ((this.written[writer]! + index) & 63);
    return bytes;
  }
  wrote(writer: number, count: number): void {
    this.written[writer]! += count;
  }
  /** One read returns bytes of exactly one write, in that writer's order. */
  check(bytes: Uint8Array): void {
    const writer = bytes[0]! >> 6;
    let counter = this.read[writer]!;
    for (let index = 0; index < bytes.length; index++, counter++) {
      if (bytes[index] === ((writer << 6) | (counter & 63))) continue;
      throw new Error(`byte ${index} of a ${bytes.length}-byte read is ${bytes[index]}`);
    }
    this.read[writer] = counter;
  }
  get pending(): number {
    return this.written.reduce((total, count, writer) => total + count - this.read[writer]!, 0);
  }
}
function drain(reader: PipeEndpoint, streams: Streams, pipe?: PipeController): void {
  const buffer = new Uint8Array(70000);
  for (let idle = 0; streams.pending > 0 && idle < 8;) {
    const count = reader.tryRead([buffer]);
    if (count > 0) {
      streams.check(buffer.subarray(0, count));
      idle = 0;
      continue;
    }
    expect(count).toBe(-PipeErrno.AGAIN);
    pipe?.pumpRelay();
    idle++;
  }
  expect(streams.pending).toBe(0);
}

test("a default pipe reserves about a tenth of its former 2.5 MiB, whatever its slot count", () => {
  const pipe = controller();
  const reader = pipe.retain(1, "read");
  const bytes = reader.handle().buffer.byteLength;
  expect(bytes).toBe(pipeReservationBytes());
  expect(bytes).toBeLessThan(300 * 1024);
  // Payload pages no longer scale with slots: each extra writer slot adds 10 KiB of
  // reserved pages, and a reader slot only its 312-byte header and page tables.
  expect(pipeReservationBytes({ maxReaders: 32 }) - bytes).toBe(16 * 312);
  expect(pipeReservationBytes({ maxWriters: 32 }) - bytes).toBeLessThan(16 * 11 * 1024);
});

test("small and large writes return every shared page once drained", () => {
  const pipe = controller();
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  const streams = new Streams(1);
  const next = random(7);
  for (let step = 0; step < 3000; step++) {
    const length = 1 + next(step % 3 === 0 ? 70000 : 300);
    const count = writer.tryWrite([streams.payload(0, length)]);
    if (count > 0) streams.wrote(0, count);
    else expect(count).toBe(-PipeErrno.AGAIN);
    if (next(4) === 0) drain(reader, streams);
  }
  drain(reader, streams);
  // An idle writer may keep the one partly used page it wrote last, but a reserved one.
  expect(pipeSharedPagesInUse(reader.handle())).toEqual({ bytes: 0, records: 0 });
});

test("a writer can always write PIPE_BUF bytes while others hold every shared page", () => {
  const pipe = controller();
  const reader = pipe.retain(1, "read");
  const writers = [2, 3, 4, 5].map((pid) => pipe.retain(pid, "write"));
  const streams = new Streams(4);
  for (const [index, writer] of writers.slice(0, 3).entries()) {
    for (;;) {
      const count = writer.tryWrite([streams.payload(index, 65536)]);
      if (count < 0) break;
      streams.wrote(index, count);
    }
  }
  expect(streams.pending).toBeGreaterThanOrEqual(65536);
  // Writers leave the delivery reserve and write into their own reserved pages.
  const shared = pipeSharedPagesInUse(reader.handle()).bytes;
  expect(shared).toBe(16);
  expect(writers[3]!.tryWrite([streams.payload(3, 4096)])).toBe(4096);
  streams.wrote(3, 4096);
  drain(reader, streams);
});

test("an atomic write that cannot get its pages leaves none behind", () => {
  const pipe = controller();
  const reader = pipe.retain(1, "read");
  const greedy = pipe.retain(2, "write"),
    other = pipe.retain(3, "write");
  const streams = new Streams(2);
  for (;;) {
    const count = greedy.tryWrite([streams.payload(0, 65536)]);
    if (count < 0) break;
    streams.wrote(0, count);
  }
  // Odd sizes leave each write straddling pages until the other writer runs out of them.
  for (;;) {
    const before = pipeSharedPagesInUse(reader.handle());
    const count = other.tryWrite([streams.payload(1, 4000)]);
    if (count > 0) {
      streams.wrote(1, count);
      continue;
    }
    expect(count).toBe(-PipeErrno.AGAIN);
    expect(pipeSharedPagesInUse(reader.handle())).toEqual(before);
    break;
  }
  expect(streams.pending).toBeLessThan(65536 + 6 * 4096);
  drain(reader, streams);
  expect(other.tryWrite([streams.payload(1, 4096)])).toBe(4096);
  streams.wrote(1, 4096);
  drain(reader, streams);
});

test("relay deliveries progress while writers hold every shared page they may take", () => {
  const pipe = controller();
  const first = pipe.retain(1, "read"),
    second = first.forProcess(2);
  expect(pipe.mode).toBe("relay");
  const writers = [3, 4, 5].map((pid) => pipe.retain(pid, "write"));
  const streams = new Streams(3);
  for (const [index, writer] of writers.entries()) {
    for (;;) {
      const count = writer.tryWrite([streams.payload(index, 65536)]);
      if (count < 0) break;
      streams.wrote(index, count);
    }
  }
  const buffer = new Uint8Array(65536);
  for (let round = 0; round < 200 && streams.pending > 0; round++) {
    for (const reader of [first, second]) {
      const count = reader.tryRead([buffer]);
      if (count > 0) streams.check(buffer.subarray(0, count));
    }
    pipe.pumpRelay();
  }
  expect(streams.pending).toBe(0);
});

for (const capacity of [8, 64, 4096, 8192, 65536]) {
  test(`random multi-writer traffic keeps every write whole and ordered (capacity ${capacity})`, () => {
    const pipe = controller({ capacity, maxWriters: 4, maxReaders: 2 });
    const reader = pipe.retain(1, "read");
    const writers = [2, 3, 4].map((pid) => pipe.retain(pid, "write"));
    const streams = new Streams(3);
    const next = random(capacity);
    const atomic = Math.min(4096, capacity);
    const buffer = new Uint8Array(capacity * 2);
    for (let step = 0; step < 6000; step++) {
      const writer = next(3);
      const length = 1 + next(next(5) === 0 ? capacity * 2 : Math.max(2, capacity >> 3));
      const count = writers[writer]!.tryWrite([streams.payload(writer, length)]);
      if (length <= atomic) expect([length, -PipeErrno.AGAIN]).toContain(count);
      if (count > 0) streams.wrote(writer, count);
      const read = reader.tryRead([buffer.subarray(0, 1 + next(buffer.length))]);
      if (read > 0) streams.check(buffer.subarray(0, read));
    }
    drain(reader, streams);
    for (const [index, writer] of writers.entries()) {
      // A write into an empty ring returns any partly used shared page first.
      expect(writer.tryWrite([streams.payload(index, 1)])).toBe(1);
      streams.wrote(index, 1);
    }
    drain(reader, streams);
    expect(pipeSharedPagesInUse(reader.handle())).toEqual({ bytes: 0, records: 0 });
  });
}

test("random relay traffic delivers every byte exactly once and in order", () => {
  const pipe = controller({ capacity: 8192 });
  const readers = [pipe.retain(1, "read")];
  readers.push(readers[0]!.forProcess(2), readers[0]!.forProcess(3));
  expect(pipe.mode).toBe("relay");
  const writer = pipe.retain(4, "write");
  const streams = new Streams(1);
  const next = random(99);
  for (let step = 0; step < 4000; step++) {
    const count = writer.tryWrite([streams.payload(0, 1 + next(3000))]);
    if (count > 0) streams.wrote(0, count);
    const buffer = new Uint8Array(1 + next(5000));
    const read = readers[next(3)]!.tryRead([buffer]);
    if (read > 0) streams.check(buffer.subarray(0, read));
    if (next(2)) pipe.pumpRelay();
  }
  for (let round = 0; round < 500 && streams.pending > 0; round++) {
    for (const reader of readers) {
      const buffer = new Uint8Array(4096);
      const read = reader.tryRead([buffer]);
      if (read > 0) streams.check(buffer.subarray(0, read));
    }
    pipe.pumpRelay();
  }
  expect(streams.pending).toBe(0);
});
