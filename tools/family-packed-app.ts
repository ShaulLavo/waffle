import { createRuntime } from "waffle";
import { basePackages } from "waffle-base";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { runLazyBaseAcceptance } from "./family-integration.ts";

const modules = [
  "waffle",
  "waffle-base",
  "waffle-coreutils",
  "waffle-findutils",
  "waffle-grep",
  "waffle-ripgrep",
  "waffle-sed",
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
    workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")),
  },
});
try {
  const result = await runLazyBaseAcceptance(
    runtime,
    new URL(import.meta.resolve("waffle/browser/preview1-worker")),
  );
  console.log(JSON.stringify({ consumer: process.cwd(), modules, result }));
} finally {
  await runtime.dispose();
}
assert.equal(runtime.disposed, true);
