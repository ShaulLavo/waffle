import { gzipSync } from "node:zlib";
import { resolve, relative } from "node:path";
import { expect, test } from "bun:test";
import { checkCoreBudget, CORE_BUDGET_BYTES } from "../tooling/runtime-size";

test("core gzip budget rejects every byte beyond its configured limit", () => {
  expect(() => checkCoreBudget(CORE_BUDGET_BYTES)).not.toThrow();
  expect(() => checkCoreBudget(CORE_BUDGET_BYTES + 1)).toThrow("by 1 B");
});

test("the full core keeps all exports without loading the process service", async () => {
  const root = resolve(import.meta.dir, "..");
  const build = await Bun.build({
    entrypoints: [resolve(root, "core/index.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    metafile: true,
  });
  expect(build.success).toBe(true);
  if (!build.metafile) throw new Error("missing full-core build metadata");
  const outputs = Object.values(build.metafile.outputs);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]?.exports.toSorted()).toEqual([
    "DescriptorTable",
    "OpenDescription",
    "Wasi",
    "WasiExit",
    "basename",
    "dirname",
    "memoryViews",
    "normalize",
    "shareFileResource",
    "splitPath",
    "withFileOffset",
  ]);
  const processInputs = Object.keys(build.metafile.inputs)
    .map((path) => relative(root, resolve(path)))
    .filter((path) => path.startsWith("proc/"));
  processInputs.sort();
  expect(processInputs).toEqual(["proc/control.ts", "proc/errors.ts", "proc/intrinsics/core.ts"]);
  const output = build.outputs[0];
  if (!output) throw new Error("missing full-core artifact");
  const size = gzipSync(Buffer.from(await output.arrayBuffer()), { level: 9 }).length;
  expect(() => checkCoreBudget(size)).not.toThrow();
});

for (const entry of ["core/index.ts", "proc/index.ts"]) {
  test(`${entry} excludes the network loader, native implementation and WASM assets`, async () => {
    const root = resolve(import.meta.dir, "..");
    const build = await Bun.build({
      entrypoints: [resolve(root, entry)],
      target: "browser",
      format: "esm",
      metafile: true,
    });
    expect(build.success).toBe(true);
    if (!build.metafile) throw new Error("missing bundle metadata");
    const inputs = Object.keys(build.metafile.inputs);
    expect(
      inputs.filter((path) =>
        /browser\/net\/(?:module|namespace)\.ts$|network\/.*\.rs$|\.wasm$/.test(path),
      ),
    ).toEqual([]);
    expect(build.outputs.some((output) => output.path.endsWith(".wasm"))).toBe(false);
  });
}
