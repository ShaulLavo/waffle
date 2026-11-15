import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import {
  TaggedCells,
  packedControl,
  reviveTaggedCells,
  serializeTaggedCells,
} from "../proc/control.ts";

test("tagged operands preserve signed values and full-width compare-exchange", () => {
  const cells = new BigInt64Array(new SharedArrayBuffer(8));
  const values = [
    -0x80000000,
    -7,
    -1,
    0,
    1,
    0x7fffffff,
    0x80000000,
    0xffffffff,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ];
  for (const id of [1, 42, 0x7fffffff]) {
    const view = new TaggedCells(cells, id);
    for (const value of values) {
      Atomics.store(cells, 0, packedControl(id, value));
      expect(view.load()).toBe(value | 0);
      expect(view.compareExchange(0, value + 1, 9)).toBe(value | 0);
      expect(Atomics.load(cells, 0)).toBe(packedControl(id, value));
      expect(view.compareExchange(0, value, -value)).toBe(value | 0);
      expect(view.load()).toBe(-value | 0);
    }
  }
});

for (const retired of [packedControl(7, 0), packedControl(7, 3), packedControl(8, 1)])
  test(`cached operands reject retired validity ${retired} before read or CAS`, () => {
    const cells = new BigInt64Array(new SharedArrayBuffer(8));
    const identity = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(cells, 0, packedControl(42, -7));
    Atomics.store(identity, 0, packedControl(7, 1));
    const original = new TaggedCells(cells, 42, { buffer: identity.buffer, byteOffset: 0, id: 7 });
    const revived = reviveTaggedCells(structuredClone(serializeTaggedCells(original)));
    expect(original.load()).toBe(-7);
    expect(revived.compareExchange(0, -7, 8)).toBe(-7);
    Atomics.store(identity, 0, retired);
    for (const view of [original, revived]) {
      expect(() => view.load()).toThrow("incarnation was collected");
      expect(() => view.compareExchange(0, 8, 9)).toThrow("incarnation was collected");
    }
    expect(Atomics.load(cells, 0)).toBe(packedControl(42, 8));
  });

test("a replacement word cannot be read or overwritten by a captured incarnation", () => {
  const cells = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(cells, 0, packedControl(42, -7));
  const old = new TaggedCells(cells, 42);
  expect(old.load()).toBe(-7);
  Atomics.store(cells, 0, packedControl(43, -7));
  expect(() => old.load()).toThrow("incarnation was collected");
  expect(() => old.compareExchange(0, -7, 9)).toThrow("incarnation was collected");
  expect(Atomics.load(cells, 0)).toBe(packedControl(43, -7));
  expect(new TaggedCells(cells, 43).load()).toBe(-7);
});

test("validity fences surround the actual native load and compare-exchange", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../proc/control.ts", import.meta.url).pathname],
    target: "browser",
    format: "cjs",
  });
  if (!built.success || !built.outputs[0]) throw Error("cannot bundle control cells");
  const context = { module: { exports: {} }, performance };
  const setup = `
    const nativeLoad = Atomics.load;
    const nativeCas = Atomics.compareExchange;
    const nativeStore = Atomics.store;
    const cells = new BigInt64Array(new SharedArrayBuffer(8));
    const identity = new BigInt64Array(new SharedArrayBuffer(8));
    let dataOperations = 0;
    let revokeAt = "none";
    function revoke(view, at) {
      if (view === cells && revokeAt === at) nativeStore(identity, 0, 0n);
    }
    function after(view) {
      if (view !== cells) return;
      dataOperations++;
      revoke(view, "after");
    }
    Atomics.load = (view, index) => {
      revoke(view, "before");
      const result = nativeLoad(view, index);
      after(view);
      return result;
    };
    Atomics.compareExchange = (view, index, expected, replacement) => {
      revoke(view, "before");
      const result = nativeCas(view, index, expected, replacement);
      after(view);
      return result;
    };
  `;
  const result: unknown = runInNewContext(
    setup.concat(
      "\n(function(){\n",
      await built.outputs[0].text(),
      "\n})();\n",
      `
    const { TaggedCells, packedControl } = module.exports;
    const view = new TaggedCells(cells, 42, { buffer: identity.buffer, byteOffset: 0, id: 7 });
    function rejected(call) {
      try { call(); } catch (error) {
        if (!error.message.includes("incarnation was collected")) throw error;
        return;
      }
      throw Error("missing validity rejection");
    }
    nativeStore(cells, 0, packedControl(42, 8));
    nativeStore(identity, 0, 0n);
    rejected(() => view.load());
    rejected(() => view.compareExchange(0, 8, 9));
    if (dataOperations !== 0) throw Error("operation entered after revocation");
    for (const at of ["before", "after"]) {
      revokeAt = at;
      nativeStore(identity, 0, packedControl(7, 1));
      rejected(() => view.load());
      nativeStore(identity, 0, packedControl(7, 1));
      nativeStore(cells, 0, packedControl(42, 8));
      rejected(() => view.compareExchange(0, 8, 9));
      if (nativeLoad(cells, 0) !== packedControl(42, 9))
        throw Error("missing native CAS before rejection");
    }
    if (dataOperations !== 4) throw Error("missing native operations");
    true;
  `,
    ),
    context,
  );
  expect(result).toBe(true);
});

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
