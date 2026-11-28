import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";
import { releaseDirectory } from "../scripts/build-findutils.ts";

const wasmPath = process.env.WAFFLE_FIND_WASM ?? join(releaseDirectory, "find.wasm");

async function runFind(module: WebAssembly.Module, scratch: string, args: string[]) {
  const stdoutPath = join(scratch, "stdout");
  const stderrPath = join(scratch, "stderr");
  await using stdout = await open(stdoutPath, "w");
  await using stderr = await open(stderrPath, "w");
  const wasi = new WASI({
    version: "preview1",
    args: ["find", "/"].concat(args),
    preopens: { "/": join(scratch, "root") },
    stdout: stdout.fd,
    stderr: stderr.fd,
  });
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const status = wasi.start(instance);
  return {
    status,
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
  };
}

test("WASI find rejects unsupported metadata predicates before traversal", async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), "waffle-find-wasi-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, "root"));
  await writeFile(join(scratch, "root", "-fstype"), "fixture");
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const unsupported = [
    ["-uid", "0"],
    ["-gid", "0"],
    ["-user", "0"],
    ["-group", "0"],
    ["-nouser"],
    ["-nogroup"],
    ["-fstype", "tmpfs"],
  ];
  for (const predicate of unsupported) {
    const result = await runFind(module, scratch, ["!"].concat(predicate, "-print"));
    assert.equal(result.status, 1, predicate[0]);
    assert.equal(result.stdout, "", predicate[0]);
    assert.ok(result.stderr.includes(`${predicate[0]} is unsupported on WASI`), result.stderr);
  }
  assert.deepEqual(await runFind(module, scratch, ["-name", "-fstype", "-print"]), {
    status: 0,
    stdout: "/-fstype\n",
    stderr: "",
  });
});
