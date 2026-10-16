import { expect, test } from "bun:test";
import { initialJavaScript, checkCoreBudget } from "./runtime-size";

test("initial download closure deduplicates static chunks and omits lazy chunks and maps", () => {
  const outputs = {
    "dist/main.js": { imports: [{ path: "./chunks/shared.js", kind: "import-statement" }, { path: "./chunks/later.js", kind: "dynamic-import" }] },
    "dist/worker.js": { imports: [{ path: "./chunks/shared.js", kind: "import-statement" }] },
    "dist/chunks/shared.js": { imports: [{ path: "./leaf.js", kind: "import-statement" }] },
    "dist/chunks/leaf.js": { imports: [{ path: "./shared.js", kind: "import-statement" }] },
    "dist/chunks/later.js": { imports: [] },
    "dist/main.js.map": { imports: [] },
  };
  expect(initialJavaScript(outputs, ["dist/main.js", "dist/worker.js"])).toEqual([
    "dist/chunks/leaf.js", "dist/chunks/shared.js", "dist/main.js", "dist/worker.js",
  ]);
});

test("initial download accounting rejects missing chunks rather than silently undercounting", () => {
  expect(() => initialJavaScript({ "dist/main.js": { imports: [{ path: "./missing.js", kind: "import-statement" }] } }, ["dist/main.js"])).toThrow("missing.js");
});

test("initial download accounting refuses unmeasured static external scripts", () => {
  expect(() => initialJavaScript({ "main.js": { imports: [{ path: "https://example.test/large.js", kind: "import-statement", external: true }] } }, ["main.js"])).toThrow("Unmeasured external");
});

test("core gzip budget includes boundary, reports actionable excess", () => {
  expect(() => checkCoreBudget(6 * 1024)).not.toThrow();
  expect(() => checkCoreBudget(6 * 1024 + 1)).toThrow("core exceeds 6144 B gzip budget by 1 B");
});
