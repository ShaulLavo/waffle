import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { PYTHON_ARGV0 } from "../src/python-payload.ts";

// Source-only unit CI does not prepare Waffle's Node exports.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const output = bundled.outputFiles[0];
assert.ok(output);
const { createPythonPackage, PYTHON_PATH }: typeof import("../src/index.ts") = await import(
  `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
);

test("Python catalog picks retain one canonical definition, source, and payload owner", () => {
  const runtime = {
    disposed: false,
    filesystem: {
      async lookup() {
        return undefined;
      },
      async readFile() {
        return undefined;
      },
      async mkdirp() {},
      async writeFile() {},
      async remove() {},
      async drain() {},
    },
  };
  const catalog = createPythonPackage(runtime, {
    payloadUrl: "https://python.test/python-stdlib.json",
  });
  assert.equal(catalog.programs.length, 1);
  const program = catalog.programs[0];
  assert.ok(program);
  assert.equal(program.path, PYTHON_PATH);
  assert.equal(program.argv0, PYTHON_ARGV0);
  assert.deepEqual(program.aliases, ["/usr/bin/python3", "/bin/python3"]);
  for (const name of ["python", PYTHON_PATH, "/usr/bin/python3", "/bin/python3"]) {
    const picked = catalog.pick(name);
    assert.deepEqual(picked.programs, [program]);
    assert.equal(picked.programs[0], program);
    assert.equal(picked.programs[0]?.source, program.source);
    assert.equal(picked.dispose, catalog.dispose);
  }
  assert.deepEqual(catalog.pick("python", "/usr/bin/python3", "/bin/python3").programs, [program]);
});
