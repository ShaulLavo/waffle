// Install the failing captured intrinsic before the production modules initialize.
if (process.argv[2] === "failed-wait") {
  const wait = Atomics.waitAsync;
  Atomics.waitAsync = (cells, index, expected, timeout) => {
    if (cells.buffer === Reflect.get(globalThis, Symbol.for("waffle.test.displayGate")))
      throw new Error("captured reader wait failed");
    if (cells instanceof BigInt64Array && typeof expected === "bigint")
      return wait(cells, index, expected, timeout);
    if (cells instanceof Int32Array && typeof expected === "number")
      return wait(cells, index, expected, timeout);
    throw new TypeError("Invalid wait width");
  };
}
await import("./runtime-display-fence.js");

export {};
