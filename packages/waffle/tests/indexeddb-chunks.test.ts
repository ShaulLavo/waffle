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
    const bytes = new Uint8Array(size);
    for (let j = 0; j < size; j++) bytes[j] = (i * 31 + j) & 0xff;
    data.set(`k:${i}`, bytes);
  }
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const toHex = (buf: ArrayBuffer) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
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
      const source = data.get(key)!;
      expect(entry.manifest.size).toBe(source.length);
      for (const [index, chunk] of entry.chunks.entries()) {
        const expected = toHex(
          await original("SHA-256", source.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
        );
        expect(chunk.checksum).toBe(expected);
      }
    }
  } finally {
    crypto.subtle.digest = original;
  }
});

test("preparePayloads stops admitting on failure and drains in-flight digests before rejecting", async () => {
  const batch1 = new Map<string, Uint8Array>();
  for (let i = 0; i < 70; i++) batch1.set(`b1:${i}`, new Uint8Array(64).fill(i & 0xff));
  const batch2 = new Map<string, Uint8Array>();
  for (let i = 0; i < 40; i++) batch2.set(`b2:${i}`, new Uint8Array(64).fill((i + 100) & 0xff));

  const original = crypto.subtle.digest.bind(crypto.subtle);
  let active = 0;
  let peak = 0;
  let calls = 0;
  let releaseHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let inFlightSettled = 0;
  crypto.subtle.digest = async (...args) => {
    const call = ++calls;
    active++;
    peak = Math.max(peak, active);
    try {
      if (call === 1) {
        await Promise.resolve();
        throw new Error("injected digest failure");
      }
      if (call <= 32) {
        await held;
        inFlightSettled++;
      }
      return await original(...args);
    } finally {
      active--;
    }
  };
  try {
    let settled = false;
    const first = preparePayloads(batch1, true).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 20 && calls < 32; i++) await Promise.resolve();
    expect(calls).toBe(32);
    expect(settled).toBe(false);
    releaseHeld!();
    await expect(first).rejects.toThrow("injected digest failure");
    expect(active).toBe(0);
    expect(inFlightSettled).toBe(31);
    expect(calls).toBe(32);

    const second = await preparePayloads(batch2, true);
    expect(second.size).toBe(40);
    expect(peak).toBeLessThanOrEqual(32);
    expect(calls).toBe(72);
  } finally {
    releaseHeld?.();
    crypto.subtle.digest = original;
  }
});

test("preparePayloads stops admitting on abort check and drains in-flight digests", async () => {
  const batch = new Map<string, Uint8Array>();
  for (let i = 0; i < 70; i++) batch.set(`a:${i}`, new Uint8Array(64).fill(i & 0xff));
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  let active = 0;
  let aborted = false;
  let releaseHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  crypto.subtle.digest = async (...args) => {
    const call = ++calls;
    active++;
    try {
      if (call === 32) {
        aborted = true;
      }
      if (call <= 32) await held;
      return await original(...args);
    } finally {
      active--;
    }
  };
  try {
    const run = preparePayloads(batch, true, () => {
      if (aborted) throw new Error("aborted before next chunk");
    });
    for (let i = 0; i < 20 && calls < 32; i++) await Promise.resolve();
    expect(calls).toBe(32);
    releaseHeld!();
    await expect(run).rejects.toThrow("aborted before next chunk");
    expect(active).toBe(0);
    expect(calls).toBe(32);
  } finally {
    releaseHeld?.();
    crypto.subtle.digest = original;
  }
});
