import { verifyPackedSearchHooks } from "./search-packed-hooks.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = resolve(process.env.PROGRAM_CONSUMER_SCRATCH ?? "/work/tmp");
await mkdir(temporary, { recursive: true });
const consumer = await mkdtemp(resolve(temporary, "waffle-programs-packed-"));
try {
  const runtimeArchive = resolve(consumer, "waffle-runtime-local.tgz");
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", runtimeArchive], {
    cwd: resolve(root, "packages/waffle"),
    stdio: "pipe",
  });
  console.log(
    JSON.stringify({
      taskLocalRuntimeArchiveSHA256: createHash("sha256")
        .update(new Uint8Array(await Bun.file(runtimeArchive).arrayBuffer()))
        .digest("hex"),
    }),
  );
  const files: Record<string, string> = { waffle: `file:${runtimeArchive}` };
  for (const family of ["base", "coreutils", "findutils", "grep", "ripgrep", "sed"]) {
    const directory = resolve(root, "packages", family);
    const manifest: unknown = await Bun.file(resolve(directory, "package.json")).json();
    assert.ok(
      manifest && typeof manifest === "object" && "name" in manifest && "version" in manifest,
    );
    assert.ok(typeof manifest.name === "string" && typeof manifest.version === "string");
    files[manifest.name] =
      `file:${resolve(directory, ".build", `${manifest.name}-${manifest.version}.tgz`)}`;
  }
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify(
      { private: true, type: "module", dependencies: files, overrides: files },
      null,
      2,
    ),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "inherit" });
  await verifyPackedSearchHooks(consumer);
  const entry = resolve(consumer, "acceptance.js");
  const bundle = await Bun.build({
    entrypoints: [resolve(root, "tools/family-packed-app.ts")],
    outdir: consumer,
    naming: "acceptance.js",
    target: "bun",
    external: Object.keys(files).concat(["waffle/*"]),
  });
  assert.ok(bundle.success, String(bundle.logs));
  execFileSync("bun", [entry], { cwd: consumer, stdio: "inherit", timeout: 90_000 });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
