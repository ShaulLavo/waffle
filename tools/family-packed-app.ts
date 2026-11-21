import { createRuntime } from "@waffle-os/runtime";
import { basePackages } from "@waffle-os/base";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { runLazyBaseAcceptance } from "./family-integration.ts";

const modules = [
  "waffle",
  "@waffle-os/base",
  "@waffle-os/coreutils",
  "@waffle-os/findutils",
  "@waffle-os/grep",
  "@waffle-os/ripgrep",
  "@waffle-os/sed",
];
const expected = resolve(process.cwd(), "node_modules") + "/";
for (const name of modules) {
  const path = realpathSync(new URL(import.meta.resolve(name)));
  assert.ok(path.startsWith(expected), `Consumer escaped its installed tarballs: ${name}: ${path}`);
}
for (const family of basePackages) {
  for (const program of family.programs) {
    assert.ok(program.wasm);
    assert.ok(
      realpathSync(program.wasm).startsWith(expected),
      `Guest escaped its tarball: ${program.path}`,
    );
  }
}
const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL(import.meta.resolve("@waffle-os/runtime/browser/fs-worker")),
  },
});
try {
  const result = await runLazyBaseAcceptance(
    runtime,
    new URL(import.meta.resolve("@waffle-os/runtime/browser/preview1-worker")),
  );
  console.log(JSON.stringify({ consumer: process.cwd(), modules, result }));
} finally {
  await runtime.dispose();
}
assert.equal(runtime.disposed, true);
