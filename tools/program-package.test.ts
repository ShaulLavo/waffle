import { stageProgram } from "./program-build-tools.ts";
import { cappedWasiFixture } from "../packages/python/scripts/wasi-artifact-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  admitProgramPackage,
  packProgramPackage,
  verifyProgramTarball,
} from "./program-package.ts";

const companionEncoders = [
  [".gz", gzipSync],
  [".br", brotliCompressSync],
] as const;

function checkProgramCompanions(root: string) {
  const guest = resolve(root, "dist/program.wasm");
  const raw = readFileSync(guest);
  assert.equal(admitProgramPackage(root).length, 6);
  for (const [suffix, encode] of companionEncoders) {
    const path = `${guest}${suffix}`;
    const valid = readFileSync(path);
    const corrupt = Buffer.from(valid);
    corrupt[0] = corrupt[0]! ^ 0xff;
    const invalid = [
      ["stale", encode(Buffer.concat([raw, Uint8Array.of(0)]))],
      ["truncated", valid.subarray(0, -1)],
      ["corrupt", corrupt],
      ["wrong content", raw],
      ["wrong encoded content", encode(cappedWasiFixture)],
      ["empty", new Uint8Array()],
    ] as const;
    for (const [description, bytes] of invalid) {
      writeFileSync(path, bytes);
      assert.throws(() => admitProgramPackage(root), Error, `${suffix} ${description}`);
      writeFileSync(path, valid);
      assert.equal(admitProgramPackage(root).length, 6);
    }
  }
  const gzip = readFileSync(`${guest}.gz`);
  const brotli = readFileSync(`${guest}.br`);
  rmSync(`${guest}.gz`);
  const partial = admitProgramPackage(root);
  assert.equal(partial.length, 5);
  assert.equal(partial.includes("dist/program.wasm.gz"), false);
  rmSync(`${guest}.br`);
  assert.deepEqual(admitProgramPackage(root), [
    "dist/program.wasm",
    "dist/program-program.json",
    "dist/NOTICES.txt",
    "dist/payload.bin",
  ]);
  writeFileSync(`${guest}.gz`, gzip);
  writeFileSync(`${guest}.br`, brotli);
  assert.equal(admitProgramPackage(root).length, 6);
}

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
      JSON.stringify({
        files: [
          "dist/program.wasm",
          "dist/program-program.json",
          "dist/NOTICES.txt",
          "dist/payload.bin",
        ],
      }),
    );
    assert.throws(() => packProgramPackage(root), /ENOENT/);
    mkdirSync(resolve(root, "dist"));
    const input = resolve(root, "input.wasm");
    writeFileSync(input, cappedWasiFixture);
    stageProgram(input, resolve(root, "dist/program.wasm"));
    assert.throws(() => packProgramPackage(root), /ENOENT/);
    writeFileSync(resolve(root, "dist/NOTICES.txt"), "fixture license\n");
    writeFileSync(resolve(root, "dist/payload.bin"), new Uint8Array(1024 * 1024 + 1));
    const guest = resolve(root, "dist/program.wasm");
    const original = readFileSync(guest);
    writeFileSync(guest, Buffer.concat([original, Uint8Array.of(0, 5, 4, 110, 97, 109, 101)]));
    assert.throws(() => admitProgramPackage(root), /still contains a name section/);
    writeFileSync(guest, original);
    checkProgramCompanions(root);
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
  const input = Buffer.concat([cappedWasiFixture, Uint8Array.of(0, 5, 4, 110, 97, 109, 101)]);
  const producer = Buffer.from(
    JSON.stringify({
      assets: { "python.wasm": digest(input) },
      interpreterBytes: input.length,
    }),
  );
  writeFileSync(
    resolve(root, "package-artifacts.json"),
    JSON.stringify({
      files: ["assets/python.wasm", "assets/python-build.json", "assets/python-program.json"],
    }),
  );
  writeFileSync(resolve(assets, "python-build.json"), producer);
  const source = resolve(root, "input.wasm");
  writeFileSync(source, input);
  const derivation = stageProgram(
    source,
    resolve(assets, "python.wasm"),
    {},
    resolve(assets, "python-build.json"),
  );
  const output = readFileSync(resolve(assets, "python.wasm"));
  const receipt = resolve(assets, "python-program.json");
  const writeReceipt = (value: unknown) => writeFileSync(receipt, JSON.stringify(value));
  writeReceipt(derivation);
  assert.equal(admitProgramPackage(root).length, 5);
  const invalid = [
    {},
    { ...derivation, operation: "unknown" },
    { ...derivation, operation: "strip-wasm-name-sections" },
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
  assert.throws(() => admitProgramPackage(root), /Final program derivation identity/);
  writeFileSync(resolve(assets, "python.wasm"), output);
  writeFileSync(resolve(assets, "python-build.json"), Buffer.concat([producer, Buffer.from(" ")]));
  assert.throws(() => admitProgramPackage(root), /Original producer receipt hash/);
  writeFileSync(resolve(assets, "python-build.json"), producer);
  assert.equal(admitProgramPackage(root).length, 5);
  assert.deepEqual(readFileSync(resolve(assets, "python-build.json")), producer);
});

test("package artifact recipes declare a derivation for every Wasm asset", () => {
  const packages = resolve(import.meta.dirname, "../packages");
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const recipePath = resolve(packages, entry.name, "package-artifacts.json");
    if (!existsSync(recipePath)) continue;
    const recipe: unknown = JSON.parse(readFileSync(recipePath, "utf8"));
    assert.ok(
      recipe && typeof recipe === "object" && "files" in recipe && Array.isArray(recipe.files),
    );
    const files: unknown[] = recipe.files;
    for (const file of files) {
      assert.ok(typeof file === "string");
      if (!file.endsWith(".wasm")) continue;
      const derivation = file.replace(/\.wasm$/, "-program.json");
      assert.ok(
        files.includes(derivation),
        `${entry.name}: missing declared derivation ${derivation}`,
      );
    }
  }
});

test("declared companions are validated once and remain required", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "declared-companions-"));
  try {
    mkdirSync(resolve(root, "dist"));
    const input = resolve(root, "input.wasm");
    const output = resolve(root, "dist/program.wasm");
    writeFileSync(input, cappedWasiFixture);
    stageProgram(input, output);
    const files = ["dist/program.wasm", "dist/program-program.json", "dist/program.wasm.br"];
    writeFileSync(resolve(root, "package-artifacts.json"), JSON.stringify({ files }));
    assert.deepEqual(admitProgramPackage(root), files.concat(["dist/program.wasm.gz"]));
    writeFileSync(`${output}.br`, brotliCompressSync(cappedWasiFixture));
    assert.throws(() => admitProgramPackage(root), /differs from final bytes/);
    rmSync(`${output}.br`);
    assert.throws(() => admitProgramPackage(root), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional leaf staging leaves compression to the shared final-output helper", () => {
  for (const recipe of ["jq/scripts/build-jaq.ts", "diffutils/scripts/build-diffutils.ts"]) {
    const source = readFileSync(new URL(`../packages/${recipe}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /brotliCompressSync|gzipSync/);
    assert.equal(Array.from(source.matchAll(/stageProgram\(guest, destination\)/g)).length, 1);
  }
});
