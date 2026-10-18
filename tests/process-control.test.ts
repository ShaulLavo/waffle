import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

for (const timeout of [1, 25]) {
  test(`tagged wait keeps its ${timeout} ms deadline after an executor replaces the global clock`, () => {
    const source = new URL("../proc/control.ts", import.meta.url).href;
    const script = `
      import { controlWait, packedControl, TaggedCells } from ${JSON.stringify(source)};
      const raw = new BigInt64Array(new SharedArrayBuffer(8));
      Atomics.store(raw, 0, packedControl(1, 0));
      const word = new TaggedCells(raw, 1);
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: { now: () => 0 },
      });
      console.log(controlWait(word, 0, 0, ${timeout}));
    `;
    // A separate process makes an infinite wait fail without stranding the suite.
    const result = execFileSync(process.execPath, ["--eval", script], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 2_000,
    });
    expect(result.trim()).toBe("timed-out");
  });
}
