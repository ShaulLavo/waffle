import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertWaffleFamilyManifest,
  parseHostInterface,
} from "../packages/waffle/tooling/host-interface.ts";
import { admitProgramPackage } from "../tools/program-package.ts";
import {
  assertInstalledHostInterfaces,
  assertOnePhysicalRuntime,
  readRuntime,
  rewriteManifest,
  runtimeReleaseUrl,
  type PackageArchive,
} from "./program-release.ts";

const provided = parseHostInterface(1, "fixture");
const manifest = {
  name: "waffle-child",
  waffleHostInterface: 1,
  peerDependencies: { waffle: "*" },
};
const control = { signal: undefined, timeoutMs: 30_000 };

function ownedFixture(run: (root: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "waffle-host-interface-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeManifest(root: string, value: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify(value));
}

test("new package recipes preserve exact Git and registry edges without interpreting them", () => {
  const git = "git+https://github.com/example/library.git#" + "a".repeat(40);
  const dependencies = { library: git, buffer: "6.0.3" };
  const context = { workspace: new Map(), urls: new Map(), runtimeHostInterface: provided };
  const result = rewriteManifest({ ...manifest, dependencies }, "0.0.92", context);
  expect(result.manifest.dependencies).toEqual(dependencies);
  expect(result.registryDependencies).toEqual(dependencies);
  expect(result.closureDependencies).toEqual({});
  expect(result.manifest.peerDependencies).toEqual({ waffle: "*" });
});

test("new release recipes reject historical exact peers, dependencies, and missing integers", () => {
  const context = { workspace: new Map(), urls: new Map(), runtimeHostInterface: provided };
  const exact = runtimeReleaseUrl("ShaulLavo/waffle", "0.0.106");
  for (const peers of [undefined, { waffle: exact }, { waffle: "^1" }]) {
    expect(() =>
      rewriteManifest({ ...manifest, peerDependencies: peers }, "0.0.92", context),
    ).toThrow(/peerDependencies.waffle/);
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    expect(() =>
      rewriteManifest({ ...manifest, [field]: { waffle: exact } }, "0.0.92", context),
    ).toThrow(/must be absent/);
  }
  for (const value of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      rewriteManifest({ ...manifest, waffleHostInterface: value }, "0.0.92", context),
    ).toThrow(/positive safe integer/);
  }
});

test("installed consumers reject missing, invalid, or mismatched runtime metadata", () => {
  ownedFixture((root) => {
    const runtime = resolve(root, "node_modules/waffle");
    for (const value of [undefined, "1", 1.1, 0, -1, Number.MAX_SAFE_INTEGER + 1, 2]) {
      writeManifest(runtime, { name: "waffle", version: "0.0.106", waffleHostInterface: value });
      expect(() => assertOnePhysicalRuntime(root, "0.0.106", provided)).toThrow();
    }
    writeManifest(runtime, { name: "waffle", version: "0.0.106", waffleHostInterface: 1 });
    expect(assertOnePhysicalRuntime(root, "0.0.106", provided)).toBe(1);
  });
});

test("installed consumers validate real family manifests before importing family code", () => {
  ownedFixture((root) => {
    const runtime = resolve(root, "node_modules/waffle");
    writeManifest(runtime, {
      name: "waffle",
      version: "0.0.106",
      waffleHostInterface: 1,
      main: "index.ts",
    });
    writeFileSync(resolve(runtime, "index.ts"), "throw new Error('must not import runtime');");
    const child = resolve(root, "node_modules/waffle-child");
    const twin: PackageArchive = { name: manifest.name, manifest, archive: "unused" };
    writeManifest(child, manifest);
    expect(assertInstalledHostInterfaces(root, [twin], provided)).toEqual([
      { name: manifest.name, waffleHostInterface: provided },
    ]);
    for (const value of [undefined, "1", 1.5, 2]) {
      const invalid = { ...manifest, waffleHostInterface: value };
      writeManifest(child, invalid);
      expect(() =>
        assertInstalledHostInterfaces(root, [{ ...twin, manifest: invalid }], provided),
      ).toThrow();
    }
  });
});

test("runtime reader validates actual archive metadata and marks a local candidate truthfully", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "waffle-interface-runtime-"));
  try {
    const source = resolve(root, "source");
    const archive = resolve(root, "waffle-local.tgz");
    for (const value of [undefined, "1", 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1, 1]) {
      writeManifest(source, { name: "waffle", version: "0.0.106", waffleHostInterface: value });
      execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
        cwd: source,
        stdio: "pipe",
      });
      const runtime = {
        url: pathToFileURL(archive).href,
        tarball: archive,
        sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
        candidateSourceCommit: "a".repeat(40),
      };
      const result = readRuntime(
        runtime,
        "ShaulLavo/waffle",
        resolve(root, String(value)),
        control,
      );
      if (value !== 1) {
        await expect(result).rejects.toThrow(/positive safe integer/);
        continue;
      }
      expect(await result).toMatchObject({
        version: "0.0.106",
        hostInterface: 1,
        input: { kind: "local-candidate", sourceCommit: "a".repeat(40) },
      });
      await expect(
        readRuntime(
          { ...runtime, url: runtimeReleaseUrl("ShaulLavo/waffle", "0.0.107") },
          "ShaulLavo/waffle",
          resolve(root, "false-public"),
          control,
        ),
      ).rejects.toThrow(/file URL/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host metadata cannot admit an invalid artifact derivation", () => {
  ownedFixture((root) => {
    const dist = resolve(root, "dist");
    mkdirSync(dist);
    writeManifest(root, manifest);
    writeFileSync(
      resolve(root, "package-artifacts.json"),
      JSON.stringify({
        files: ["dist/program.wasm", "dist/program-program.json"],
      }),
    );
    writeFileSync(resolve(dist, "program.wasm"), Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    writeFileSync(resolve(dist, "program-program.json"), "{}");
    expect(assertWaffleFamilyManifest(manifest, "fixture")).toBe(provided);
    expect(() => admitProgramPackage(root)).toThrow();
  });
});
