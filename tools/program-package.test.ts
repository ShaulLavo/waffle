import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Python packing binds its derivation to original producer and final interpreter", (context) => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "python-admission-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = resolve(root, "assets");
  mkdirSync(assets);
  const output = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const input = Buffer.concat([output, Uint8Array.of(0, 5, 4, 110, 97, 109, 101)]);
  const producer = Buffer.from(
    JSON.stringify({
      assets: { "python.wasm": digest(input) },
      interpreterBytes: input.length,
    }),
  );
  const derivation = {
    operation: "strip-wasm-name-sections",
    producerReceiptSha256: digest(producer),
    input: { bytes: input.length, sha256: digest(input) },
    output: { bytes: output.length, sha256: digest(output) },
  };
  writeFileSync(
    resolve(root, "package-artifacts.json"),
    JSON.stringify({
      files: ["assets/python.wasm", "assets/python-build.json", "assets/python-program.json"],
    }),
  );
  writeFileSync(resolve(assets, "python.wasm"), output);
  writeFileSync(resolve(assets, "python-build.json"), producer);
  const receipt = resolve(assets, "python-program.json");
  const writeReceipt = (value: unknown) => writeFileSync(receipt, JSON.stringify(value));
  writeReceipt(derivation);
  assert.equal(admitProgramPackage(root).length, 3);
  const invalid = [
    {},
    { ...derivation, operation: "unknown" },
    { ...derivation, producerReceiptSha256: "0".repeat(64) },
    { ...derivation, input: { ...derivation.input, sha256: "0".repeat(64) } },
    { ...derivation, input: { ...derivation.input, bytes: input.length + 1 } },
    { ...derivation, output: { ...derivation.output, sha256: "0".repeat(64) } },
    { ...derivation, output: { ...derivation.output, bytes: output.length + 1 } },
  ];
  for (const value of invalid) {
    writeReceipt(value);
    assert.throws(() => admitProgramPackage(root));
  }
  writeReceipt(derivation);
  const changed = Buffer.concat([output, Uint8Array.of(0, 3, 1, 120, 42)]);
  new WebAssembly.Module(changed);
  writeFileSync(resolve(assets, "python.wasm"), changed);
  assert.throws(() => admitProgramPackage(root), /Python program output/);
  writeFileSync(resolve(assets, "python.wasm"), output);
  writeFileSync(resolve(assets, "python-build.json"), Buffer.concat([producer, Buffer.from(" ")]));
  assert.throws(() => admitProgramPackage(root), /Python producer receipt/);
  writeFileSync(resolve(assets, "python-build.json"), producer);
  assert.equal(admitProgramPackage(root).length, 3);
  assert.deepEqual(readFileSync(resolve(assets, "python-build.json")), producer);
});
