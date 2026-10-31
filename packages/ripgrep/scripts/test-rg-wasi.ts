import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rgCases, rgFiles, rgUnsupported } from "../tests/helpers/rg-fixtures.ts";

const root = resolve(import.meta.dirname, "..");
const native = process.argv[2] === "--native" ? process.argv[3] : undefined;
assert.ok(
  process.argv.length === 2 || (native && process.argv.length === 4),
  "Use [--native <rg executable>]",
);
const scratch = await mkdtemp(resolve(root, ".build/rg-fixtures-"));
try {
  for (const [name, text] of Object.entries(rgFiles)) {
    const path = resolve(scratch, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const guest = resolve(root, "dist/rg.wasm");
  for (const fixture of rgCases) {
    const result = spawnSync(
      native ?? "wasmtime",
      native ? fixture.args : ["run", "--dir", `${scratch}::.`, guest].concat(fixture.args),
      { cwd: scratch, input: fixture.stdin, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, fixture.status, fixture.name);
    assert.equal(result.stdout, fixture.stdout, fixture.name);
    if (fixture.error) assert.ok(result.stderr.includes(fixture.error), result.stderr);
    else assert.equal(result.stderr, "", fixture.name);
  }
  if (!native) {
    const startup = spawnSync(
      "wasmtime",
      ["run", "--env", "PWD=/missing-working-directory", guest, "needle"],
      { encoding: "utf8" },
    );
    assert.equal(startup.status, 2, "invalid startup working directory");
    assert.match(startup.stderr, /No such file or directory/);
  }
  for (const fixture of native ? [] : rgUnsupported) {
    const result = spawnSync(
      "wasmtime",
      ["run", "--dir", `${scratch}::.`, guest].concat(fixture.args, ["needle", "."]),
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes(fixture.error), result.stderr);
  }
  console.log(
    `ripgrep ${native ? "native" : "WASI"}: ${rgCases.length} behavior cases and ${native ? 0 : rgUnsupported.length} platform errors passed`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
