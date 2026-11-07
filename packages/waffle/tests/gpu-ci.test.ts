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
test("the producer restores the pinned SDK even when every compiled fixture cache hits", () => {
  const steps = producer.split(/(?=      - )/);
  const sdk = steps.find((step) => step.includes("id: sdk"));
  const install = steps.find((step) => step.includes("name: Install pinned wasi-sdk 34"));
  expect(sdk).toBeDefined();
  expect(sdk).not.toContain("if:");
  expect(sdk).toContain(
    "wasi-sdk-34-b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4",
  );
  expect(install).toContain("if: steps.sdk.outputs.cache-hit != 'true'");
  expect(install).not.toContain("steps.fixtures");
  expect(install).not.toContain("steps.gpu-fixture");
});
test("GPU source freshness covers schema, generated C layouts and the handwritten fixture", () => {
  for (const input of [
    "triangle.c",
    "scene.c",
    "scene_encode.h",
    "async.c",
    "async_encode.h",
    "async-expected.json",
    "webgpu.h",
    "gpu_fixture.h",
    "gpu_encode.h",
    "waffle_gpu_stream.h",
    "webgpu.yml",
    "stream.json",
    "tables.ts",
    "browser/gpu/codec.ts",
    "browser/gpu/metadata.ts",
    "browser/display/generated/graphics-layout.ts",
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

test("GPU cache inputs match the fixture receipt and all generator freshness inputs and outputs", () => {
  const builder = readFileSync(new URL("../scripts/build-gpu-fixture.ts", import.meta.url), "utf8");
  const inventory = builder.match(/const inputs = \[([\s\S]*?)\n\];/)?.[1];
  const generator = readFileSync(new URL("../tooling/gpu-stream.ts", import.meta.url), "utf8");
  const fixed = generator.match(/const fixedInputs = \[([\s\S]*?)\n\];/)?.[1];
  const outputs = generator.match(/const outputs:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  if (!inventory || !fixed || !outputs)
    throw new Error("GPU fixture or generator inventory missing");
  const expected = Array.from(
    new Set(
      Array.from(
        (inventory + fixed + outputs).matchAll(/"([^"]+)"/g),
        (match) => `packages/waffle/${match[1]}`,
      ),
    ),
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
  expect(step).toContain("gpu-scene-fixture.test.ts");
  expect(step).toContain("compiled textured depth scene");
  expect(step).toContain("gpu-fairness-fixture.test.ts");
  expect(step).toContain("compiled fairness fixture");
  expect(step).toContain("gpu-async-fixture.test.ts");
  expect(step).toContain("real compiled C decoder under protocol controls, not native acceptance");
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
    "compiled textured depth scene, protocol assertions",
    "compiled fairness fixture, protocol and deterministic scheduling",
    "real compiled C decoder under protocol controls, not native acceptance",
  ];
  const passing = suites
    .map(
      (name, index) =>
        `<testsuite name="${name}">${"<testcase/>".repeat(index === 0 ? 31 : index === 5 ? 20 : 1)}</testsuite>`,
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
    const asyncSuite = `<testsuite name="${suites[5]}">${"<testcase/>".repeat(20)}</testsuite>`;
    expect(passing).toContain(asyncSuite);
    expect(check(passing.replace(asyncSuite, ""))).not.toBe(0);
    expect(check(passing.replace(asyncSuite, `<testsuite name="${suites[5]}"/>`))).not.toBe(0);
    expect(check(passing.replace(asyncSuite, asyncSuite.replace("<testcase/>", "")))).not.toBe(0);
    for (const tag of ["skipped", "failure", "error"])
      expect(
        check(
          passing.replace(
            asyncSuite,
            asyncSuite.replace("<testcase/>", `<testcase><${tag}/></testcase>`),
          ),
        ),
      ).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the GPU producer installs pinned generator tools before a cache-miss build", () => {
  const installation = producer.indexOf("run: bun install --frozen-lockfile --ignore-scripts");
  const build = producer.indexOf("name: Build the compiled GPU guest once");
  expect(installation).toBeGreaterThan(producer.indexOf("Verify exact-input network artifact"));
  expect(installation).toBeLessThan(build);
  const precedingStep = producer
    .slice(0, installation)
    .split(/(?=      - )/)
    .at(-1);
  expect(precedingStep).toBeDefined();
  expect(precedingStep).not.toContain("if:");
  expect(producer.slice(0, installation)).toContain("path: ~/.bun/install/cache");
});

const sourceName = "wasm32 C whole-map sentinel normalizes before widening against pinned header";
test("the SDK source sentinel executes once in the producer regardless of fixture cache hits", () => {
  const step = producer
    .split(/(?=      - )/)
    .find((entry) => entry.includes("gpu-async-stream.test.ts"));
  expect(step).toBeDefined();
  expect(step).not.toContain("if:");
  expect(step).toContain("WASI_SDK_PATH: ${{ runner.temp }}/wasi-sdk-34.0-x86_64-linux");
  expect(step).toContain(`--test-name-pattern '^${sourceName}$'`);
  expect(step).toContain("--reporter=junit");
  expect(producer.split("bun test packages/waffle/tests/gpu-async-stream.test.ts")).toHaveLength(2);
  expect(consumer).not.toContain("gpu-async-stream.test.ts");
  expect(producer.indexOf("id: sdk")).toBeLessThan(producer.indexOf(step!));
});

test("the source sentinel JUnit guard rejects missing, duplicate, skipped or failed controls", () => {
  const step = producer
    .split(/(?=      - )/)
    .find((entry) => entry.includes("gpu-async-stream.test.ts"));
  const python = step?.match(/<<'PYTHON'\n([\s\S]*?)\n\s*PYTHON/)?.[1];
  if (!python) throw new Error("Source sentinel report guard missing");
  const code = python
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const root = mkdtempSync(join(tmpdir(), "gpu-source-report-"));
  const report = join(root, "report.xml");
  try {
    const check = (xml: string) => {
      writeFileSync(report, `<testsuites><testsuite>${xml}</testsuite></testsuites>`);
      return Bun.spawnSync(["python3", "-c", code, report]).exitCode;
    };
    const passing = `<testcase name="${sourceName}"/>`;
    expect(check(passing)).toBe(0);
    expect(check("")).not.toBe(0);
    expect(check(passing + passing)).not.toBe(0);
    expect(check('<testcase name="unrelated"/>')).not.toBe(0);
    for (const tag of ["skipped", "failure", "error"])
      expect(check(`<testcase name="${sourceName}"><${tag}/></testcase>`)).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
