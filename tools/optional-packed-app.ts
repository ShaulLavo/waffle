import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createRuntime } from "waffle";
import { installGit } from "waffle-git";
import { GIT_CLI_URL } from "waffle-git/program";
import { qualifyPython } from "../packages/python/test/qualification.ts";

const expected = resolve(process.cwd(), "node_modules") + "/";
for (const name of [
  "waffle",
  "waffle-git",
  "waffle-git/program",
  "@waffle/python",
  "@waffle/python/install",
])
  assert.ok(realpathSync(new URL(import.meta.resolve(name))).startsWith(expected), name);
assert.ok(realpathSync(GIT_CLI_URL).startsWith(expected));
const pythonEntry = new URL(import.meta.resolve("@waffle/python"));
const nodeRoot = new URL(".", import.meta.resolve("waffle"));
const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("browser/fs-worker.js", nodeRoot) },
});
try {
  const python = await qualifyPython(runtime, {
    workerUrl: new URL(import.meta.resolve("waffle/browser/preview1-worker")),
    wasmUrl: new URL("../assets/python.wasm", pythonEntry),
    payloadUrl: new URL("../assets/python-stdlib.json", pythonEntry),
  });
  const git = await installGit(runtime);
  try {
    await runtime.filesystem.mkdirp("/packed-git");
    let stdout = "",
      stderr = "";
    const status = await git.run({
      argv: ["init", "-b", "main"],
      cwd: "/packed-git",
      env: {},
      stdout: (bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
      stderr: (bytes) => {
        stderr += new TextDecoder().decode(bytes);
      },
    });
    assert.equal(status, 0, stderr);
    assert.equal(
      new TextDecoder().decode(await runtime.filesystem.readFile("/packed-git/.git/HEAD")),
      "ref: refs/heads/main\n",
    );
    console.log(
      JSON.stringify({
        packedPython: python,
        packedGit: { status, stdout, stderr, publicCliUrl: GIT_CLI_URL.href },
      }),
    );
  } finally {
    await git.dispose();
  }
} finally {
  await runtime.dispose();
}
assert.equal(runtime.disposed, true);
