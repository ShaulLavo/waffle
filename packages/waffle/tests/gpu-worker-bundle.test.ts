import { expect, test } from "bun:test";
import { build } from "vite";
import { resolve } from "node:path";

for (const [kind, entry] of [
  ["source", "browser/display/owner.ts"],
  ["prepared Node", "dist/browser/display/owner.js"],
] as const) {
  test(`${kind} display bundles a JavaScript GPU worker instead of a raw TypeScript asset`, async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      root: resolve(import.meta.dir, ".."),
      build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "display" } },
    });
    const results = Array.isArray(result) ? result : [result];
    const outputs = results.flatMap((entry) => ("output" in entry ? entry.output : []));
    const display = outputs.find(
      (output) => output.type === "chunk" && output.fileName === "display.js",
    );
    if (!display || display.type !== "chunk") throw new Error("Vite display entry missing");
    expect(display.code.includes("data:video/mp2t")).toBe(false);
    const workers = outputs.filter((output) => /service-worker-.*\.js$/.test(output.fileName));
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    const source = worker.type === "asset" ? String(worker.source) : worker.code;
    expect(source.includes("requestAdapter")).toBe(true);
    expect(source.includes("createTexture")).toBe(true);
    expect(source.includes('from "./service.js"')).toBe(false);
  });
}
