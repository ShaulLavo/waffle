import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  admitProgramPackage,
  packProgramPackage,
  verifyProgramTarball,
} from "./program-package.ts";

test("pack rejects absent guests and notices, and verifies actual archive closure", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "package-admission-"));
  try {
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", files: ["dist"] }),
    );
    writeFileSync(
      resolve(root, "package-artifacts.json"),
      JSON.stringify({ files: ["dist/program.wasm", "dist/NOTICES.txt", "dist/payload.bin"] }),
    );
    assert.throws(() => packProgramPackage(root), /ENOENT/);
    mkdirSync(resolve(root, "dist"));
    writeFileSync(
      resolve(root, "dist/program.wasm"),
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    assert.throws(() => packProgramPackage(root), /ENOENT/);
    writeFileSync(resolve(root, "dist/NOTICES.txt"), "fixture license\n");
    writeFileSync(resolve(root, "dist/payload.bin"), new Uint8Array(1024 * 1024 + 1));
    const guest = resolve(root, "dist/program.wasm");
    const original = readFileSync(guest);
    writeFileSync(guest, Buffer.concat([original, Uint8Array.of(0, 5, 4, 110, 97, 109, 101)]));
    assert.throws(() => admitProgramPackage(root), /still contains a name section/);
    writeFileSync(guest, original);
    assert.equal(admitProgramPackage(root).length, 3);
    const archive = packProgramPackage(root);
    assert.ok(readFileSync(archive).length > 0);
    writeFileSync(resolve(root, "dist/NOTICES.txt"), "changed license\n");
    assert.throws(() => verifyProgramTarball(root, archive), /Packed asset differs/);
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.0.0", files: ["package.json"] }),
    );
    assert.throws(() => packProgramPackage(root), /tar|Command failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
