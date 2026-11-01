import assert from "node:assert/strict";
import { createRuntime } from "waffle";
import { defineProgramPackage } from "waffle/programs";
import { DescriptorTable } from "../../core/descriptors.js";
import { createProgramShell } from "./program-shell.js";
import { wasiCat } from "./wasi-cat.js";
let attempts = 0;
const tables: DescriptorTable[] = [];
const pkg = defineProgramPackage({
  name: "cat",
  programs: [
    {
      path: "/usr/bin/cat",
      aliases: ["/bin/cat"],
      source: async () => {
        attempts++;
        return wasiCat();
      },
    },
  ],
});
const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL("browser/fs-worker.js", import.meta.resolve("waffle")),
  },
  programs: { onDemand: [pkg] },
});
try {
  await runtime.programs.ready;
  await runtime.filesystem.writeFile("/prepared-input", "prepared default worker\n");
  const shell = await createProgramShell(runtime, tables);
  const exit = await shell.exec("/bin/cat", ["cat", "/prepared-input"]);
  assert.equal(exit.kind, "exited");
  assert.equal(exit.code, 0);
  assert.equal(shell.output.join(""), "prepared default worker\n");
  assert.equal(attempts, 1);
  assert.equal(runtime.programs.get("cat")?.state.kind, "loaded");
} finally {
  await runtime.dispose();
  for (const table of tables) table.dispose();
}
