import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import manifest from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const temporary =
  process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = mkdtempSync(join(temporary, "waffle-relay-pack-"));
try {
  const archive = join(scratch, "relay.tgz");
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
    cwd: root,
    stdio: "pipe",
  });
  execFileSync("tar", ["-xzf", archive, "-C", scratch]);
  const packed = join(scratch, "package");
  mkdirSync(join(scratch, "node_modules"));
  symlinkSync(resolve(root, "../waffle"), join(scratch, "node_modules/waffle"), "dir");
  symlinkSync(resolve(root, "node_modules/ws"), join(scratch, "node_modules/ws"), "dir");
  for (const [name, conditions] of Object.entries(manifest.exports)) {
    assert.ok(existsSync(resolve(packed, conditions.types)), `Missing types for ${name}`);
    assert.ok(existsSync(resolve(packed, conditions.node)), `Missing Node entry for ${name}`);
    const entry = pathToFileURL(resolve(packed, conditions.node)).href;
    execFileSync(
      "node",
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry)})`],
      { stdio: "pipe", timeout: 5000 },
    );
  }
  const source = readFileSync(join(packed, "src/index.ts"), "utf8");
  assert.ok(!source.includes("./node"), "Browser client entry imports a Node adapter");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.ok(!entries.some((entry) => /node_modules|\.test\.ts|\.pem$|\/tests\//.test(entry)));
  console.log(
    JSON.stringify({
      packedEntries: entries.length,
      checkedExports: Object.keys(manifest.exports),
      packageBytes: Bun.file(archive).size,
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
