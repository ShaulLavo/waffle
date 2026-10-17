import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBaselineSource } from "./process-baseline-source";

const directories = new Set<string>();
afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

async function snapshot() {
  const directory = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-baseline-source-"));
  directories.add(directory);
  await mkdir(join(directory, "runtime"));
  await mkdir(join(directory, "web/src"), { recursive: true });
  return directory;
}

const fixtures = ["process-bench-baseline.ts", "process-benchmark.ts"];
test("baseline setup preserves the selected revision's own measurement harness", async () => {
  const directory = await snapshot();
  await mkdir(join(directory, "web/tests"));
  const sentinel = join(directory, "web/tests/existing-test.ts");
  await writeFile(sentinel, "// Frozen archive test remains unchanged.\n");
  for (const name of fixtures) await writeFile(join(directory, "web/tests", name), `// Frozen ${name}; do not inject the current harness.\n`);

  await prepareBaselineSource(directory);

  expect(await readlink(join(directory, "web/node_modules/@bun-wasm/runtime"))).toBe(join(directory, "runtime"));
  for (const name of fixtures) {
    expect(await readFile(join(directory, "web/tests", name), "utf8")).toBe(`// Frozen ${name}; do not inject the current harness.\n`);
  }
  expect(await readFile(sentinel, "utf8")).toBe("// Frozen archive test remains unchanged.\n");
});

for (const missing of fixtures) {
  test(`baseline archive without ${missing} is rejected with an archive command`, async () => {
    const directory = await snapshot();
    await mkdir(join(directory, "web/tests"));
    for (const name of fixtures) if (name !== missing) await writeFile(join(directory, "web/tests", name), "// Frozen harness.\n");
    await expect(prepareBaselineSource(directory)).rejects.toThrow(`Baseline archive is missing web/tests/${missing}`);
    await expect(prepareBaselineSource(directory)).rejects.toThrow("git archive REV web/src runtime web/tests/process-bench-baseline.ts web/tests/process-benchmark.ts");
  });
}
