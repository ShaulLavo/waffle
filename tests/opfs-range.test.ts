import { expect, test } from "bun:test";
import { RangeFixture, pattern, payloadSize } from "./fixtures/opfs-range-storage";

async function fixture(run: (value: RangeFixture) => Promise<void>, sizes?: number[]) {
  const value = new RangeFixture();
  try {
    await value.seed(sizes);
    await run(value);
  } finally {
    await value.cleanup();
  }
}

// This causal control uses the existing full read until the range API exists.
test("cold 4KiB request reads and allocates only 4KiB of a retained 128MiB payload", () => fixture(async value => {
  const owner = await value.open();
  const bytes = await owner.read("revision:0");
  expect(bytes.byteLength).toBe(4096);
  expect(value.file().reads.reduce((sum, call) => sum + call.length, 0)).toBe(4096);
  expect(Array.from(new Set(value.file().reads.map(call => call.buffer)), buffer => buffer.byteLength)).toEqual([4096]);
  expect(bytes[0]).toBe(pattern(65539));
  expect(value.file().reads[0]?.at).toBe(65539);
  expect(value.file().size).toBe(payloadSize);
}));
