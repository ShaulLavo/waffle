import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { wasiBuildEnvironment, wasiTarget } from "./wasi-build.ts";
import { ripgrepNotices } from "./rg-notices.ts";
import { patchRipgrepSource } from "./rg-source.ts";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";

const root = resolve(import.meta.dirname, "..");
const revision = "6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30";
const archiveSha256 = "bc5a3bc1c3d58a192a3c4731c6f2aa159e74b007ce6200d7f6ef05d8fb4e000e";
const source = resolve(root, ".sources/ripgrep");
const patch = resolve(root, "patches/ripgrep-wasi.patch");
const identity = createHash("sha256")
  .update(revision)
  .update(await readFile(patch))
  .update(await readFile(new URL("./rg-source.ts", import.meta.url)))
  .digest("hex");
const receipt = resolve(source, ".bash-web-recipe");

if ((await readFile(receipt, "utf8").catch(() => "")) !== identity) {
  const response = await fetch(`https://codeload.github.com/BurntSushi/ripgrep/tar.gz/${revision}`);
  if (!response.ok) throw new Error(`ripgrep source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), archiveSha256);
  const archive = resolve(root, ".build/ripgrep.tar.gz");
  await mkdir(resolve(root, ".build"), { recursive: true });
  await writeFile(archive, bytes);
  try {
    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    patchRipgrepSource(source, patch);
    await writeFile(receipt, identity);
  } finally {
    await rm(archive, { force: true });
  }
}

const target = resolve(root, ".build/ripgrep");
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    wasiTarget,
    "--bin",
    "rg",
    "--no-default-features",
    "-j2",
  ],
  {
    cwd: source,
    env: {
      ...wasiBuildEnvironment(root, target),
      CARGO_PROFILE_RELEASE_DEBUG: "0",
      CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
      GIT_CEILING_DIRECTORIES: resolve(root, ".sources"),
    },
    stdio: "inherit",
  },
);
const guest = resolve(target, wasiTarget, "release/rg.wasm");
verifyWasiGuest(guest);
for (const directory of ["dist", "public/programs"]) {
  await mkdir(resolve(root, directory), { recursive: true });
  await copyFile(guest, resolve(root, directory, "rg.wasm"));
}

const notices = await ripgrepNotices(source, process.env);
for (const directory of ["dist", "public/programs"])
  await writeFile(resolve(root, directory, "rg.NOTICES.txt"), notices);
