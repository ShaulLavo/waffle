import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const temporary =
  process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = mkdtempSync(join(temporary, "waffle-relay-worker-"));
try {
  const result = await Bun.build({
    entrypoints: [resolve(root, "tests/worker-entry.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  assert.ok(result.success, result.logs.map(String).join("\n"));
  assert.ok(result.outputs[0]);
  const output = join(scratch, "worker.js");
  await Bun.write(output, result.outputs[0]);
  execFileSync("node", [resolve(root, "scripts/worker-platform.ts"), output, scratch], {
    stdio: "inherit",
    timeout: 30000,
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
