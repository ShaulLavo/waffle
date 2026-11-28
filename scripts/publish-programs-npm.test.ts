import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostInterface } from "../packages/waffle/tooling/host-interface.ts";
import type { ReleasedPackage } from "./program-release.ts";
import { packNpmProgram } from "./publish-programs-npm.ts";

function identity(bytes: Uint8Array) {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function createArchive(root: string, files: string[]) {
  const source = join(root, "staged.tgz");
  const stage = join(root, "package");
  mkdirSync(stage);
  const name = "@waffle-os/fixture";
  const version = "0.0.24";
  const dependency = "@waffle-os/coreutils";
  const hostInterface = parseHostInterface(3, "fixture");
  const assetBase = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.24";
  const edge = `${assetBase}/waffle-coreutils-0.0.24.tgz`;
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  writeFileSync(join(stage, "guest.wasm"), wasm);
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({
      name,
      version,
      private: true,
      files,
      waffleHostInterface: hostInterface,
      dependencies: { [dependency]: edge },
      peerDependencies: { "@waffle-os/runtime": "*" },
      scripts: { prepack: "exit 1" },
    }),
  );
  execFileSync("tar", ["-czf", source, "-C", root, "package"]);
  const pkg: ReleasedPackage = {
    name,
    version,
    waffleHostInterface: hostInterface,
    sourceDirectory: "packages/fixture",
    sourceTree: "f".repeat(40),
    sourceVersion: "0.0.0",
    filename: "staged.tgz",
    url: `${assetBase}/waffle-fixture-0.0.24.tgz`,
    ...identity(readFileSync(source)),
    closureDependencies: { [dependency]: edge },
    registryDependencies: {},
    strippedFields: [],
    typeOnlyUndeclared: [],
    artifacts: [{ path: "guest.wasm", ...identity(wasm) }],
    guests: { descriptor: ["guest.wasm"], staticReference: [] },
  };
  const closure = new Map([[dependency, { ...pkg, name: dependency, url: edge }]]);
  return { source, pkg, closure, wasm };
}

test("the npm receipt records the packed archive, exact dependency edges and original guest bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "waffle-npm-receipt-test-"));
  try {
    const { source, pkg, closure, wasm } = createArchive(root, ["guest.wasm"]);
    const { archive, receipt } = packNpmProgram(source, pkg, closure, root);
    expect(receipt).toMatchObject({
      ...identity(readFileSync(archive)),
      url: "https://registry.npmjs.org/@waffle-os/fixture/-/fixture-0.0.24.tgz",
      filename: "fixture-0.0.24.tgz",
      closureDependencies: { "@waffle-os/coreutils": "0.0.24" },
      artifacts: pkg.artifacts,
    });
    expect(receipt.sha256).not.toBe(pkg.sha256);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies).toEqual(receipt.closureDependencies);
    expect(manifest.peerDependencies).toEqual({ "@waffle-os/runtime": "*" });
    expect(execFileSync("tar", ["-xOf", archive, "package/guest.wasm"])).toEqual(Buffer.from(wasm));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm repacking refuses an archive without all admitted guest files", () => {
  const root = mkdtempSync(join(tmpdir(), "waffle-npm-receipt-test-"));
  try {
    const { source, pkg, closure } = createArchive(root, []);
    expect(() => packNpmProgram(source, pkg, closure, root)).toThrow(/guest\.wasm/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
