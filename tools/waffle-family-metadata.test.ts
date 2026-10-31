import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  assertExactHostInterface,
  assertSourceWaffleFamilyManifest,
  assertWaffleFamilyManifest,
  parseHostInterface,
  type HostInterface,
} from "../packages/waffle/tooling/host-interface.ts";
import { admitProgramPackage } from "./program-package.ts";
import { assertSourceWaffleMetadata } from "./waffle-family-metadata.ts";

const repository = resolve(import.meta.dirname, "..");
const runtimeInterface = parseHostInterface(1, "runtime");

function familyManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: "waffle-family",
    version: "0.0.0",
    waffleHostInterface: 1,
    devDependencies: { waffle: "workspace:*" },
    peerDependencies: { waffle: "*" },
    ...overrides,
  };
}

test("parses only positive safe integer host interfaces", () => {
  assert.equal(parseHostInterface(1, "fixture"), 1);
  assert.equal(parseHostInterface(Number.MAX_SAFE_INTEGER, "fixture"), Number.MAX_SAFE_INTEGER);

  for (const value of [undefined, null, 0, -1, 1.5, Infinity, NaN, "1", 1n]) {
    expect(() => parseHostInterface(value, "fixture")).toThrow(/positive safe integer/);
  }
  expect(() => parseHostInterface(Number.MAX_SAFE_INTEGER + 1, "fixture")).toThrow(
    /positive safe integer/,
  );
});

test("requires exact equality and rejects missing or mismatched values", () => {
  const required = parseHostInterface(1, "family");
  const provided = parseHostInterface(1, "runtime");
  expect(() => assertExactHostInterface(required, provided, "family")).not.toThrow();
  expect(() =>
    assertExactHostInterface(required, parseHostInterface(2, "runtime"), "family"),
  ).toThrow("requires waffleHostInterface 1, runtime provides 2");
  expect(() =>
    assertWaffleFamilyManifest(familyManifest({ waffleHostInterface: undefined }), "family"),
  ).toThrow(/positive safe integer/);
});

test("requires the wildcard peer and forbids nested runtime placement", () => {
  expect(() => assertWaffleFamilyManifest(familyManifest(), "family")).not.toThrow();
  for (const peer of [undefined, "workspace:*", "^1.0.0"]) {
    expect(() =>
      assertWaffleFamilyManifest(
        familyManifest({ peerDependencies: peer === undefined ? undefined : { waffle: peer } }),
        "family",
      ),
    ).toThrow(/peerDependencies\.waffle/);
  }
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    expect(() =>
      assertWaffleFamilyManifest(familyManifest({ [field]: { waffle: "workspace:*" } }), "family"),
    ).toThrow(`${field}.waffle must be absent`);
  }
});

test("source families keep a workspace development edge and exact runtime metadata", () => {
  expect(() =>
    assertSourceWaffleFamilyManifest(familyManifest(), "family", runtimeInterface),
  ).not.toThrow();
  expect(() =>
    assertSourceWaffleFamilyManifest(
      familyManifest({ devDependencies: undefined }),
      "family",
      runtimeInterface,
    ),
  ).toThrow(/devDependencies\.waffle/);
  expect(() =>
    assertSourceWaffleFamilyManifest(
      familyManifest({ devDependencies: { waffle: "*" } }),
      "family",
      runtimeInterface,
    ),
  ).toThrow(/devDependencies\.waffle/);
  expect(() =>
    assertSourceWaffleFamilyManifest(
      familyManifest({ waffleHostInterface: 2 }),
      "family",
      runtimeInterface,
    ),
  ).toThrow(/requires waffleHostInterface 2, runtime provides 1/);
});

test("the repository source metadata gate covers every Waffle family", () => {
  assert.equal(assertSourceWaffleMetadata(repository), 1);
});

test("metadata validation does not replace artifact and receipt admission", () => {
  const root = mkdtempSync(join(tmpdir(), "waffle-host-interface-"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), JSON.stringify(familyManifest()));
    writeFileSync(
      join(root, "package-artifacts.json"),
      JSON.stringify({ files: ["dist/program.wasm", "dist/program-program.json"] }),
    );
    writeFileSync(join(root, "dist/program.wasm"), Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    writeFileSync(join(root, "dist/program-program.json"), "{}");

    const metadata: HostInterface = assertSourceWaffleFamilyManifest(
      familyManifest(),
      "fixture/package.json",
      runtimeInterface,
    );
    assert.equal(metadata, 1);
    assert.throws(() => admitProgramPackage(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
