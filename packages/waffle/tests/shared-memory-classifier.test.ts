import { expect, test } from "bun:test";

async function classifyWith(pool: number, perObject = Infinity) {
  const { classify } = await import("../memory/probe-classifier.js");
  const attempts: number[] = [];
  const retained: object[] = [];
  let held = 0;
  const result = classify((maximum) => {
    attempts.push(maximum);
    if (maximum > perObject || held + maximum > pool) throw new RangeError("native refusal");
    held += maximum;
    return {};
  }, retained);
  return { result, attempts, retained };
}
const GiB = 1024 ** 3;
test("F4 per-object 8 GiB cap with unlimited pool reaches 16 GiB in two holders", async () => {
  const { result, attempts, retained } = await classifyWith(Infinity, 8 * GiB);
  expect(result).toEqual({ reachedBytes: 16 * GiB, chunkBytes: 8 * GiB, ceilingReached: true });
  expect(attempts).toEqual([16 * GiB, 8 * GiB, 8 * GiB]);
  expect(retained).toHaveLength(2);
});
test("F4 bounded pool stops at the first refusal after success without filling", async () => {
  const { result, attempts, retained } = await classifyWith(17_062_428_672);
  expect(result).toEqual({ reachedBytes: 8 * GiB, chunkBytes: 8 * GiB, ceilingReached: false });
  expect(attempts).toEqual([16 * GiB, 8 * GiB, 8 * GiB]);
  expect(retained).toHaveLength(1);
});
test("F4 unavailable pool halves only before success and retains nothing", async () => {
  const { result, attempts, retained } = await classifyWith(256 * 1024 ** 2 - 1);
  expect(result).toEqual({ reachedBytes: 0, chunkBytes: 0, ceilingReached: false });
  expect(attempts).toEqual([16, 8, 4, 2, 1, 0.5, 0.25].map((n) => n * GiB));
  expect(retained).toHaveLength(0);
});
test("classifier propagates non-capacity failures", async () => {
  const { classify } = await import("../memory/probe-classifier.js");
  expect(() =>
    classify(() => {
      throw new TypeError("unsupported growable buffer");
    }, []),
  ).toThrow(TypeError);
});

test("F5 the worker constructs no fixed buffers or Wasm memories for bounded classification", async () => {
  const worker = new Worker(new URL("./fixtures/memory-classifier-control.ts", import.meta.url));
  try {
    const observation = await new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    expect(observation).toEqual({
      result: { reachedBytes: 8 * GiB, chunkBytes: 8 * GiB, ceilingReached: false },
      fixed: 0,
      memories: 0,
      attempts: [16 * GiB, 8 * GiB, 8 * GiB],
    });
  } finally {
    worker.onmessage = null;
    worker.onerror = null;
    await worker.terminate();
  }
});
