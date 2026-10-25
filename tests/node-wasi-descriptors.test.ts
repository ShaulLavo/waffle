import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type * as NodeWasiFixture from "./fixtures/node-wasi-descriptors.ts";

const root = resolve(import.meta.dir, "..");
const scratch = join(root, ".tmp-node-wasi-descriptors");
const bundle = join(scratch, "node-wasi-descriptors.mjs");

async function buildFixture(_fixture?: typeof NodeWasiFixture): Promise<void> {
  mkdirSync(scratch, { recursive: true });
  const output = await Bun.build({
    entrypoints: ["tests/fixtures/node-wasi-descriptors.ts"],
    target: "node",
    outdir: scratch,
    naming: "node-wasi-descriptors.mjs",
  });
  if (!output.success) throw new Error(output.logs.join("\n"));
}

test("Node WASI descriptor routing preserves native and Waffle namespaces", async () => {
  try {
    await buildFixture();
    expect(existsSync(bundle)).toBe(true);
    expect(
      execFileSync("node", ["--no-warnings", bundle], { cwd: root, encoding: "utf8" }),
    ).toContain("Node WASI descriptor routing and mixed poll passed");
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});
