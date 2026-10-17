import { expect, test } from "bun:test";
import { resolveRuntimePackage } from "./browser-build";
import { join } from "node:path";
import { initialJavaScript, checkCoreBudget, checkLazyProcessService, checkLazyInterruptRewriter, processServiceInputs } from "./runtime-size";

const runtime = resolveRuntimePackage(join(import.meta.dir, "../web/src/main.ts"));
const installed = (file: string) => join(runtime.path, file);

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

test("the first-spawn service gate allows reservation primitives but rejects service code", () => {
  const inputs = ["proc/stub.ts", "proc/identity.ts", "proc/outcome.ts", "proc/signals.ts", "proc/types.ts", "web/src/subprocess.ts"].map(installed);
  expect(() => checkLazyProcessService(inputs, runtime)).not.toThrow();
  expect(processServiceInputs(inputs.concat([installed("proc/table.ts")]), runtime)).toEqual([installed("proc/table.ts")]);
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/supervisor.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/index.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/registry.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/future-service.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("dist/proc/supervisor.js")]), runtime)).toThrow("process service is eager");
});

test("core gzip budget includes boundary, reports actionable excess", () => {
  expect(() => checkCoreBudget(7 * 1024)).not.toThrow();
  expect(() => checkCoreBudget(7 * 1024 + 1)).toThrow("core exceeds 7168 B gzip budget by 1 B");
});

test("Bun light initial downloads allow the tiny fatal check but never the binary rewriter", () => {
  const inputs = ["interrupt/check.ts", "proc/outcome.ts", "web/src/subprocess-broker.ts"].map(installed);
  expect(() => checkLazyInterruptRewriter(inputs, runtime)).not.toThrow();
  for (const file of ["rewriter", "loader", "index", "future-compiler"]) {
    expect(() => checkLazyInterruptRewriter(inputs.concat([installed(`interrupt/${file}.ts`)]), runtime)).toThrow("interrupt rewriter is eager");
  }
  expect(() => checkLazyInterruptRewriter([installed("dist/interrupt/rewriter.js")], runtime)).toThrow("interrupt rewriter is eager");
});

test("lookalike proc and interrupt paths outside the installed package are not attributed", () => {
  const paths = ["/outside-the-package/runtime/proc/supervisor.ts", "/cache/other.runtime.git/proc/supervisor.ts", "/cache/other.runtime.git/interrupt/rewriter.ts"];
  expect(processServiceInputs(paths, runtime)).toEqual([]);
  expect(() => checkLazyInterruptRewriter(paths, runtime)).not.toThrow();
});
