import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
