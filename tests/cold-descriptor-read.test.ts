import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import { coldByte, coldDescriptorFixture, coldSize } from "./fixtures/cold-descriptor";

for (const reads of [
  [{ offset: 123, length: 1 }],
  [{ offset: coldSize, length: 1 }, { offset: 123, length: 0 }],
  [{ offset: 123, length: 1 }, { offset: 123, length: 1 }, { offset: PAGE - 2, length: 5 }],
]) {
  test(`exported cold descriptor reads ${JSON.stringify(reads)} without whole hydration`, async () => {
    const fixture = await coldDescriptorFixture();
    try {
      const before = fixture.backend.shared.resources().usedBytes;
      const outcome = await fixture.run(reads);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.results.map(({ error }) => error)).toEqual(reads.map(() => 0));
      const expected = reads.map(({ offset, length }) => Math.min(length, coldSize - offset));
      expect(outcome.results.map(({ count }) => count)).toEqual(expected);
      expect(outcome.results.map(({ bytes }, index) => bytes.slice(0, expected[index]))).toEqual(
        reads.map(({ offset }, index) => Array.from({ length: expected[index]! }, (_, at) => coldByte(offset + at))),
      );
      expect(fixture.counters.wholeBytes).toBe(0);
      expect(fixture.counters.rangeBytes).toBe(expected.reduce((sum, count) => sum + count, 0));
      expect(fixture.backend.shared.resources().usedBytes).toBe(before);
      expect(fixture.counters.retained).toBe(0);
    } finally { await fixture.close(); }
  });
}
