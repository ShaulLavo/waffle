import { expect, test } from "bun:test";
import {
  CHUNK_SIZE,
  chunkChecksum,
  parseManifest,
  parseChunk,
  preparePayload,
  preparePayloads,
  validateRange,
} from "../fs/indexeddb-chunks.js";

for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1]) {
  test(`chunk representation and checksums for ${size} bytes`, async () => {
    const input = new Uint8Array(size).fill(41);
    const prepared = await preparePayload(input);
    const manifest = parseManifest(prepared.manifest, "key");
    expect(manifest.count).toBe(Math.ceil(size / CHUNK_SIZE));
    expect(prepared.chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0)).toBe(size);
    for (const chunk of prepared.chunks)
      expect(await chunkChecksum(parseChunk(chunk, chunk.bytes.length, "key").bytes)).toBe(
        chunk.checksum,
      );
    input.fill(0);
    expect(prepared.chunks.every((chunk) => chunk.bytes.every((byte) => byte === 41))).toBe(true);
  });
}
for (const offset of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid range ${offset} rejects`, () => {
    expect(() => validateRange({ offset, length: 1 })).toThrow(RangeError);
    expect(() => validateRange({ offset: 1, length: offset })).toThrow(RangeError);
  });
}
test("safe range sum and exact abort reason", () => {
  expect(() => validateRange({ offset: Number.MAX_SAFE_INTEGER, length: 1 })).toThrow(RangeError);
  validateRange({ offset: Number.MAX_SAFE_INTEGER, length: 0 });
  const reason = { cancelled: "exact identity" };
  const controller = new AbortController();
  controller.abort(reason);
  let thrown: unknown;
  try {
    validateRange({ offset: 0, length: 1, signal: controller.signal });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(reason);
});
for (const value of [
  undefined,
  new Uint8Array(2),
  {},
  { version: 2, size: -1 },
  { version: 2, size: 3, count: 1, chunkSize: 4096 },
  { version: 2, size: 0, count: 1, chunkSize: CHUNK_SIZE },
]) {
  test(`malformed manifest ${JSON.stringify(value)}`, () => {
    expect(() => parseManifest(value, "key")).toThrow("Invalid filesystem payload chunks");
  });
}

test("preparePayloads runs digests concurrently within a bounded worker pool", async () => {
  const data = new Map<string, Uint8Array>();
  for (let i = 0; i < 64; i++) {
    const size = i === 0 ? CHUNK_SIZE * 2 + 13 : i === 1 ? 0 : 128 + i;
    data.set(`k:${i}`, new Uint8Array(size).fill(i & 0xff));
  }
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let active = 0;
  let peak = 0;
  crypto.subtle.digest = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await Promise.resolve();
      return await original(...args);
    } finally {
      active--;
    }
  };
  try {
    const prepared = await preparePayloads(data, true);
    expect(prepared.size).toBe(64);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    expect(prepared.get("k:0")!.chunks).toHaveLength(3);
    expect(prepared.get("k:1")!.chunks).toHaveLength(0);
    for (const [key, entry] of prepared) {
      for (const chunk of entry.chunks) {
        expect(await original("SHA-256", chunk.bytes)).toBeDefined();
        expect(chunk.checksum).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(entry.manifest.size).toBe(data.get(key)!.length);
    }
  } finally {
    crypto.subtle.digest = original;
  }
});
