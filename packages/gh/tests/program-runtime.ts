import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { afterEach, expect, test } from "bun:test";
import { basePackages } from "../../base/src/index.ts";
import { DescriptorTable } from "../../waffle/core/descriptors.ts";
import { createRuntime, type Runtime } from "../../waffle/index.ts";
import { createProgramShell } from "../../waffle/tests/fixtures/program-shell.ts";
import { wasiCat } from "../../waffle/tests/fixtures/wasi-cat.ts";
import { createGhPackage } from "../src/program.ts";

let runtime: Runtime | undefined;
let table: DescriptorTable | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  table?.dispose();
  table = undefined;
});

test("gh loads on demand through the explicitly registered interpreter", async () => {
  assert.ok(basePackages.every((pkg) => pkg.name !== "gh"));
  let interpreterLoads = 0;
  let scriptLoads = 0;
  const interpreter = {
    name: "fixture-interpreter",
    programs: [
      {
        path: "/bin/interpreter",
        source: async () => {
          interpreterLoads++;
          return wasiCat();
        },
      },
    ],
  };
  const gh = createGhPackage({
    interpreter: "/bin/interpreter",
    source: async () => {
      scriptLoads++;
      return "gh fixture payload\n";
    },
  });
  runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [interpreter, gh] },
  });
  await runtime.programs.ready;
  expect(runtime.programs.get("gh")?.state.kind).toBe("registered");
  expect(interpreterLoads).toBe(0);
  expect(scriptLoads).toBe(0);
  await runtime.programs.preload("gh");
  expect(interpreterLoads).toBe(1);
  expect(scriptLoads).toBe(1);
  table = new DescriptorTable();
  const shell = await createProgramShell(runtime, [table]);
  expect(await shell.exec("/bin/gh", ["gh"])).toMatchObject({ kind: "exited", code: 0 });
  expect(shell.output.join("")).toBe("#!/bin/interpreter\ngh fixture payload\n");
});
