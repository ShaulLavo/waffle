import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import type { PackageProgram } from "waffle/programs";
import { basePackages } from "waffle-base";
import { runLazyBaseAcceptance } from "./family-integration.ts";
import { admitProgramPackage, packProgramPackage } from "./program-package.ts";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workerUrl = new URL("../packages/waffle/browser/preview1-worker.ts", import.meta.url);

test("25 real programs install lazily, run on one generic runtime, and release their paths", async () => {
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../packages/waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  try {
    await runLazyBaseAcceptance(runtime, workerUrl);
  } finally {
    await runtime.dispose();
  }
  assert.equal(runtime.disposed, true);
}, 90_000);

test("every shipped guest has only public imports and complete packed license/assets", () => {
  for (const family of basePackages) {
    const directory = resolve(root, "packages", family.name);
    const required = admitProgramPackage(directory);
    assert.ok(required.some((file) => file.endsWith("NOTICES.txt")));
    for (const program of family.programs) assertPublicGuest(program);
    console.log(JSON.stringify({ family: family.name, archive: packProgramPackage(directory) }));
  }
  console.log(
    JSON.stringify({ family: "base", archive: packProgramPackage(resolve(root, "packages/base")) }),
  );
}, 90_000);

function assertPublicGuest(program: PackageProgram) {
  assert.ok(program.wasm);
  const module = new WebAssembly.Module(readFileSync(program.wasm));
  for (const imported of WebAssembly.Module.imports(module))
    assert.ok(
      !["shell_terminal", "waffle_program", "waffle_executable"].includes(imported.module),
      `${program.path}: private import ${imported.module}`,
    );
}
