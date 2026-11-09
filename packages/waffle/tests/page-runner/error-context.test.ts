import { expect, test } from "bun:test";
import { ProcessError } from "../../proc/errors.js";
import { spawnError } from "../../proc/start-failure.js";
import { formatHostError } from "./protocol.js";

test("native cause class, message, stack and mapped numeric errno reach the page report", () => {
  const native = new RangeError("Out of memory");
  native.stack = "RangeError: Out of memory\n    at originalAllocation (native.ts:17:3)";
  const converted = spawnError(native);
  const wrapped = new Error("Notification scenario revoked failed", { cause: converted });
  const text = formatHostError(wrapped);
  expect(text).toContain(wrapped.message);
  expect(text).toContain("ProcessError: Out of memory");
  expect(text).toContain("errno=48");
  expect(text).toContain(native.stack);
});

test("nested causes stop at a bounded depth and cyclic causes terminate", () => {
  let error = new Error("unreachable tail");
  for (let depth = 0; depth < 100; depth++) error = new Error(`wrapper ${depth}`, { cause: error });
  const nested = formatHostError(error);
  expect(nested).toContain("wrapper 99");
  expect(nested).toContain("wrapper 98");
  expect(nested).not.toContain("unreachable tail");
  const cyclic = new Error("cycle");
  Object.defineProperty(cyclic, "cause", { value: cyclic });
  expect(formatHostError(cyclic)).toContain("[circular]");
});

test("oversized values and aggregate width stay within the escaped wire budget", () => {
  const error = new ProcessError(29, '😀\u0000"\\'.repeat(100_000));
  Object.defineProperty(error, "cause", { value: new Error("native tail") });
  error.stack = "stack".repeat(100_000);
  const text = formatHostError(new AggregateError(Array(100).fill(error), "aggregate"));
  expect(new TextEncoder().encode(JSON.stringify(text)).byteLength).toBeLessThanOrEqual(8192);
  expect(text).toContain("aggregate");
  expect(formatHostError(new ProcessError(NaN, "not numeric"))).not.toContain("errno=");
});

test("only safe scalar error descriptors are read, never accessors or object conversion", () => {
  let reads = 0;
  const unsafe = () => {
    reads++;
    throw new Error("private authority");
  };
  const error = Object.create(null);
  for (const key of ["name", "message", "stack", "errno", "cause", "errors", "toString"]) {
    Object.defineProperty(error, key, { get: unsafe });
  }
  expect(() => formatHostError(error)).not.toThrow();
  expect(reads).toBe(0);
  const payload = { toString: unsafe, toJSON: unsafe, private: "secret" };
  expect(formatHostError(new Error("safe", { cause: payload }))).not.toContain("secret");
  expect(reads).toBe(0);
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  expect(() => formatHostError(proxy.proxy)).not.toThrow();
});

test("aggregate cause accessors and indexed getters are not invoked", () => {
  let reads = 0;
  const values: Error[] = [];
  Object.defineProperty(values, "0", { get: () => { reads++; throw new Error("private"); } });
  values.length = 100_000;
  const error = new AggregateError([], "safe aggregate");
  Object.defineProperty(error, "errors", { value: values });
  expect(() => formatHostError(error)).not.toThrow();
  Object.defineProperty(error, "errors", { get: () => { reads++; throw new Error("private"); } });
  expect(() => formatHostError(error)).not.toThrow();
  expect(reads).toBe(0);
});
