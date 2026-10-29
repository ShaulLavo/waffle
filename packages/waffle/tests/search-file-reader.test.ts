import { expect, test } from "bun:test";
import { CONTROL_ABORT, CONTROL_CHUNKS, CONTROL_WORDS, FileReader } from "../search/shards.ts";

function control(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(CONTROL_WORDS * 4));
}

const bytes = new TextEncoder().encode("absent\n".repeat(14000) + "needle\n");

test("a short positive filesystem read is not EOF", () => {
  const cells = control();
  const reader = new FileReader(cells, 1024 * 1024);
  const offsets: number[] = [];
  const result = reader.read((chunk, offset) => {
    offsets.push(offset);
    const read = bytes.subarray(offset, offset + Math.min(chunk.length, 65536));
    chunk.set(read);
    return read.length;
  });
  expect(result).toEqual(bytes);
  expect(offsets).toEqual([0, 65536, 98007]);
  expect(Atomics.load(cells, CONTROL_CHUNKS)).toBe(3);
});

test("short reads still enforce the input bound without returning partial bytes", () => {
  const cells = control();
  const reader = new FileReader(cells, 65536);
  const result = reader.read((chunk, offset) => {
    const read = bytes.subarray(offset, offset + Math.min(chunk.length, 32768));
    chunk.set(read);
    return read.length;
  });
  expect(result).toBe(22);
});

test("cancellation after a short read is observed before another read", () => {
  const cells = control();
  const reader = new FileReader(cells, 1024 * 1024);
  let reads = 0;
  const result = reader.read((chunk) => {
    reads++;
    chunk.set(bytes.subarray(0, 65536));
    Atomics.store(cells, CONTROL_ABORT, 1);
    return 65536;
  });
  expect(result).toBe(6);
  expect(reads).toBe(1);
});

test("an error following a short read is returned instead of partial file contents", () => {
  const reader = new FileReader(control(), 1024 * 1024);
  const result = reader.read((chunk, offset) => {
    if (offset) return -29;
    chunk.set(bytes.subarray(0, 65536));
    return 65536;
  });
  expect(result).toBe(29);
});
