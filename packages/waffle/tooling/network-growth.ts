import assert from "node:assert/strict";

export const NETWORK_GROWTH = { slabs: 136, slabPages: 65, envelopePages: 16384 } as const;
const PAGE = 65536;
function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`Missing network export ${name}`);
  const result: unknown = fn(...args);
  if (typeof result !== "number") throw new Error(`Invalid network export ${name}`);
  return result;
}
/** Exact-artifact allocator regression: only equal slabs allocate after fixed initialization.
 * No native tcp_* operation or differently sized allocation is interleaved with this trace.
 */
export async function networkGrowth(bytes: Uint8Array<ArrayBuffer>) {
  const { instance } = await WebAssembly.instantiate(bytes, { waffle_tcp_host: { io: () => -10 } });
  const exports = instance.exports;
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing network memory");
  const pointer = call(exports, "tcp_buffer");
  const initialPages = memory.buffer.byteLength / PAGE;
  const growthPages: number[] = [];
  const ids: number[] = [];
  const write = (id: number, length: number): number => {
    const before = memory.buffer.byteLength;
    const slabs = Math.ceil(call(exports, "net_usage", 2) / 64);
    new Uint8Array(memory.buffer, pointer, length).fill(id & 255);
    const count = call(exports, "net_write", id, length);
    const growth = (memory.buffer.byteLength - before) / PAGE;
    if (Math.ceil(call(exports, "net_usage", 2) / 64) > slabs) growthPages.push(growth);
    return count;
  };
  try {
    for (let pair = 0; pair < 256; pair++) {
      const id = call(exports, "net_pair");
      assert.ok(id > 0);
      ids.push(id, call(exports, "net_peer", id));
    }
    for (const id of ids) {
      const peer = call(exports, "net_peer", id);
      assert.equal(write(id, 2000), 2000);
      assert.equal(call(exports, "net_take", peer, 1000), 1000);
      call(exports, "net_consumed", peer, 1000);
      let sent = 1000;
      for (let count = write(id, PAGE); count > 0; count = write(id, PAGE)) sent += count;
      assert.equal(sent, 1 << 20);
      assert.equal(write(id, 1), -1);
    }
    assert.equal(call(exports, "net_usage", 2), 8704);
    assert.equal(growthPages.length, NETWORK_GROWTH.slabs);
    assert.ok(growthPages.every((pages) => pages <= NETWORK_GROWTH.slabPages));
    const peakPages = memory.buffer.byteLength / PAGE;
    assert.ok(peakPages <= NETWORK_GROWTH.envelopePages);
    return { initialPages, growthPages, peakPages };
  } finally {
    call(exports, "tcp_dispose");
  }
}
export function verifyNetworkGrowth(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("growthPages" in value) ||
    !Array.isArray(value.growthPages)
  )
    throw new Error("Missing network allocator growth trace");
  if (
    value.growthPages.length !== NETWORK_GROWTH.slabs ||
    !value.growthPages.every(
      (n: unknown) =>
        typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= NETWORK_GROWTH.slabPages,
    )
  )
    throw new Error("Network allocator growth premise changed; establish a new bound");
  if (
    !("initialPages" in value) ||
    typeof value.initialPages !== "number" ||
    !("peakPages" in value) ||
    typeof value.peakPages !== "number" ||
    value.initialPages + value.growthPages.reduce((a: number, b: number) => a + b, 0) !==
      value.peakPages ||
    value.peakPages > NETWORK_GROWTH.envelopePages
  )
    throw new Error("Network allocator growth envelope mismatch");
}
