import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareBaselineSource } from "./process-baseline-source";

const directories = new Set<string>();
afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

for (const full of [false, true]) {
  test(`baseline setup accepts ${full ? "a full archive with existing tests" : "a narrow source archive"}`, async () => {
    const snapshot = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-baseline-source-"));
    directories.add(snapshot);
    await mkdir(join(snapshot, "runtime"));
    await mkdir(join(snapshot, "web/src"), { recursive: true });
    const sentinel = join(snapshot, "web/tests/existing-test.ts");
    if (full) {
      await mkdir(join(snapshot, "web/tests"));
      await writeFile(sentinel, "// Frozen archive test remains unchanged.\n");
      await writeFile(join(snapshot, "web/tests/process-benchmark.ts"), "// Replaced by the current measurement harness.\n");
    }

    await prepareBaselineSource(snapshot, import.meta.dir);

    expect(await readlink(join(snapshot, "web/node_modules/@bun-wasm/runtime"))).toBe(join(snapshot, "runtime"));
    for (const name of ["process-bench-baseline.ts", "process-benchmark.ts"]) {
      expect(await readFile(join(snapshot, "web/tests", name), "utf8")).toBe(await readFile(join(import.meta.dir, name), "utf8"));
    }
    if (full) expect(await readFile(sentinel, "utf8")).toBe("// Frozen archive test remains unchanged.\n");
  });
}
