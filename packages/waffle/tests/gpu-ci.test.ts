import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const producer = workflow.slice(
  workflow.indexOf("\n  libc:\n"),
  workflow.indexOf("\n  browser:\n"),
);
const consumer = workflow.slice(workflow.indexOf("\n  browser:\n"));
test("GPU compiler restoration and installation include a fixture-only cache miss", () => {
  const sdk = producer.slice(
    producer.indexOf(
      "      - uses: actions/cache@v4\n        if: steps.fixtures.outputs.cache-hit",
    ),
  );
  expect(sdk).toContain("steps.gpu-fixture.outputs.cache-hit != 'true'");
  expect(sdk).toContain(
    "(steps.fixtures.outputs.cache-hit != 'true' || steps.group-fixture.outputs.cache-hit != 'true' || steps.gpu-fixture.outputs.cache-hit != 'true') && steps.sdk.outputs.cache-hit != 'true'",
  );
});
test("GPU source freshness covers schema, generated C layouts and the handwritten fixture", () => {
  for (const input of [
    "triangle.c",
    "gpu_encode.h",
    "waffle_gpu_stream.h",
    "webgpu.yml",
    "stream.json",
    "tables.ts",
    "gpu-stream*.ts",
    "build-gpu-fixture.ts",
  ])
    expect(producer).toContain(input);
  expect(
    (
      producer.match(
        /run: bun packages\/waffle\/scripts\/build-gpu-fixture.ts "\$RUNNER_TEMP\/gpu-fixture"/g,
      ) ?? []
    ).length,
  ).toBe(1);
  expect(producer).toContain("gpu-artifact");
});
test("browser jobs consume and verify the one producer artifact without recompiling", () => {
  expect(consumer).toContain("artifact-ids: ${{ needs.libc.outputs.gpu-artifact-id }}");
  expect(consumer).toContain('build-gpu-fixture.ts --verify "$RUNNER_TEMP/gpu-fixture"');
  expect(consumer).toContain("GPU_FIXTURE_DIR: ${{ runner.temp }}/gpu-fixture");
  expect(workflow).toContain("bun run size && bun run size:network && bun run size:gpu");
  const suites = readFileSync(new URL("../scripts/test-browser.ts", import.meta.url), "utf8");
  expect(suites).toContain('"tests/gpu-browser-runner.ts"');
});

test("GPU cache inputs match every source input in the fixture receipt", () => {
  const builder = readFileSync(new URL("../scripts/build-gpu-fixture.ts", import.meta.url), "utf8");
  const inventory = builder.match(/const inputs = \[([\s\S]*?)\n\];/)?.[1];
  if (!inventory) throw new Error("GPU fixture input inventory missing");
  const expected = Array.from(
    inventory.matchAll(/"([^"]+)"/g),
    (match) => `packages/waffle/${match[1]}`,
  );
  const key = producer.match(/key: [^\n]*gpu-fixture-sdk34[^\n]*/)?.[0];
  if (!key) throw new Error("GPU fixture cache key missing");
  const patterns = Array.from(key.matchAll(/'([^']+)'/g), (match) => match[1]!);
  const inputs = patterns.flatMap((pattern) =>
    Array.from(
      new Bun.Glob(pattern).scanSync({
        cwd: resolve(import.meta.dir, "../../.."),
        onlyFiles: true,
      }),
    ),
  );
  expect(expected.length).toBeGreaterThan(0);
  expect(inputs.sort()).toEqual(expected.sort());
});

test("the producer runs only the compiled fixture suites with its verified artifact", () => {
  const step = producer
    .split(/(?=      - )/)
    .find((entry) => entry.includes("bun test packages/waffle/tests/gpu-fixture.test.ts"));
  expect(step).toBeDefined();
  expect(step).toContain("GPU_FIXTURE_DIR: ${{ runner.temp }}/gpu-fixture");
  expect(step).toContain("--test-name-pattern");
  expect(step).toContain("compiled Preview 1 C fixture");
  expect(step).toContain("compiled C completion handling");
  expect(step).toContain("bounded frame-mode wire controls");
  expect(step).toContain("--reporter=junit");
  expect(step).toContain("assert");
  expect(step).toContain("skipped");
  expect(step).not.toContain("WASI_SDK_PATH");
  expect(producer.indexOf("build-gpu-fixture.ts --verify")).toBeLessThan(producer.indexOf(step!));
});

test("compiled-suite report guard rejects missing, empty, filtered or failed assertions", () => {
  const step = producer
    .split(/(?=      - )/)
    .find((entry) => entry.includes("bun test packages/waffle/tests/gpu-fixture.test.ts"));
  const python = step?.match(/<<'PYTHON'\n([\s\S]*?)\n\s*PYTHON/)?.[1];
  if (!python) throw new Error("Compiled GPU report guard missing");
  const code = python
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const suites = [
    "compiled Preview 1 C fixture",
    "compiled C completion handling, not GPU acceptance",
    "bounded frame-mode wire controls, not native GPU acceptance",
  ];
  const passing = suites
    .map(
      (name, index) =>
        `<testsuite name="${name}">${"<testcase/>".repeat(index === 0 ? 15 : 1)}</testsuite>`,
    )
    .join("");
  const root = mkdtempSync(join(tmpdir(), "gpu-ci-report-"));
  const report = join(root, "report.xml");
  try {
    const check = (xml: string) => {
      writeFileSync(report, `<testsuites>${xml}</testsuites>`);
      return Bun.spawnSync(["python3", "-c", code, report]).exitCode;
    };
    expect(check(passing + "<testcase><skipped/></testcase>")).toBe(0);
    expect(check(passing.replace(/<testsuite[^>]*>[\s\S]*?<\/testsuite>/, ""))).not.toBe(0);
    expect(check(passing.replace("<testcase/>", ""))).not.toBe(0);
    for (const tag of ["skipped", "failure", "error"])
      expect(check(passing.replace("<testcase/>", `<testcase><${tag}/></testcase>`))).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
