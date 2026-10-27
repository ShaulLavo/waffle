import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi";
import { MemFS } from "../fs/memory";

function host() {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("rejected or expired clocks must not wait");
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  wasi.bindMemory(memory);
  return { wasi, memory, calls: wasi["functions"]() };
}

for (const id of [2, 3, 4, -1, 0xffffffff, -2147483648]) {
  test(`clock ${id} fails without changing output`, () => {
    const { calls, memory } = host();
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(0xa5);
    expect(calls.clock_time_get(id, 0n, 128)).toBe(28);
    expect(calls.clock_res_get(id, 128)).toBe(28);
    expect(calls.clock_time_get(id, 0n, -1)).toBe(28);
    expect(calls.clock_res_get(id, -1)).toBe(28);
    expect(bytes.every((byte) => byte === 0xa5)).toBe(true);
  });
}

for (const id of [0, 1]) {
  test(`supported clock ${id} retains its domain, resolution and grown-memory output`, () => {
    const { calls, memory } = host();
    expect(calls.clock_res_get(id, 0)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(0, true)).toBe(1000n);
    const before = id === 0 ? Date.now() : performance.now();
    expect(calls.clock_time_get(id, 0n, 8)).toBe(0);
    const first = new DataView(memory.buffer).getBigUint64(8, true);
    expect(Number(first) / 1e6).toBeGreaterThanOrEqual(before - 100);
    expect(Number(first) / 1e6).toBeLessThanOrEqual(
      (id === 0 ? Date.now() : performance.now()) + 100,
    );
    memory.grow(1);
    expect(calls.clock_time_get(id, 0n, 65536)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(65536, true)).toBeGreaterThanOrEqual(first);
  });

  test(`supported clock ${id} returns EFAULT without mutation for invalid output spans`, () => {
    const { calls, memory } = host();
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(0xa5);
    for (const ptr of [65529, 65536, -1, -2147483648]) {
      expect(calls.clock_time_get(id, 0n, ptr)).toBe(21);
      expect(calls.clock_res_get(id, ptr)).toBe(21);
    }
    expect(bytes.every((byte) => byte === 0xa5)).toBe(true);
    expect(calls.clock_res_get(id, 65528)).toBe(0);
  });
}

for (const flags of [0, 1]) {
  test(`poll flags ${flags} reports CPU and invalid clock errors alongside expired supported clocks`, () => {
    const { calls, memory } = host();
    const view = new DataView(memory.buffer);
    const ids = [0, 1, 2, 3, 4, 0xffffffff];
    ids.forEach((id, index) => {
      view.setBigUint64(index * 48, BigInt(index), true);
      view.setUint32(index * 48 + 16, id, true);
      view.setUint16(index * 48 + 40, flags, true);
    });
    expect(calls.poll_oneoff(0, 1024, ids.length, 2048)).toBe(0);
    expect(view.getUint32(2048, true)).toBe(ids.length);
    const errors = new Map<bigint, number>();
    for (let index = 0; index < ids.length; index++) {
      const at = 1024 + index * 32;
      expect(view.getUint8(at + 10)).toBe(0);
      errors.set(view.getBigUint64(at, true), view.getUint16(at + 8, true));
    }
    expect(Array.from(ids, (_, index) => errors.get(BigInt(index)))).toEqual([
      0, 0, 28, 28, 28, 28,
    ]);
  });
}

test("poll rejects invalid output spans before waiting or partially writing events", () => {
  const { calls, memory } = host();
  const bytes = new Uint8Array(memory.buffer);
  // Two CPU subscriptions, both immediately rejected.
  const view = new DataView(memory.buffer);
  view.setUint32(16, 2, true);
  view.setUint32(64, 3, true);
  const before = bytes.slice();
  expect(calls.poll_oneoff(0, 65504, 2, 2048)).toBe(21);
  expect(calls.poll_oneoff(0, 1024, 2, 65533)).toBe(21);
  expect(calls.poll_oneoff(0, -1, 2, 2048)).toBe(21);
  expect(calls.poll_oneoff(0, 1024, 2, -1)).toBe(21);
  expect(bytes).toEqual(before);
});

function text(value: string): number[] {
  return [value.length].concat(Array.from(new TextEncoder().encode(value)));
}

function section(id: number, bytes: number[]): number[] {
  if (bytes.length >= 128) throw new Error("fixture section exceeds one-byte LEB");
  return [id, bytes.length].concat(bytes);
}

test("a real Wasm guest observes CPU-clock errno rather than a time or trap", () => {
  const module = new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(
          1,
          [3, 0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f],
        ),
        section(
          2,
          [2].concat(
            text("wasi_snapshot_preview1"),
            text("clock_time_get"),
            [0, 0],
            text("wasi_snapshot_preview1"),
            text("clock_res_get"),
            [0, 1],
          ),
        ),
        section(3, [1, 2]),
        section(7, [1].concat(text("probe"), [0, 2])),
        // Return the sum of both CPU ids' getter errors; the host checks output sentinels.
        section(
          10,
          [
            1, 33, 0, 0x41, 2, 0x42, 0, 0x41, 0, 0x10, 0, 0x41, 3, 0x42, 0, 0x41, 8, 0x10, 0, 0x6a,
            0x41, 2, 0x41, 16, 0x10, 1, 0x6a, 0x41, 3, 0x41, 24, 0x10, 1, 0x6a, 0x0b,
          ],
        ),
      ),
    ),
  );
  const { wasi, memory } = host();
  const bytes = new Uint8Array(memory.buffer);
  bytes.fill(0xa5);
  const { probe } = new WebAssembly.Instance(module, wasi.imports(module)).exports;
  if (typeof probe !== "function") throw new Error("missing clock probe");
  expect(probe()).toBe(4 * 28);
  expect(bytes.every((byte) => byte === 0xa5)).toBe(true);
});
