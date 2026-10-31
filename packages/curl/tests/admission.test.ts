import { expect, test } from "bun:test";
import type { PackageProgram } from "../../waffle/programs/index.ts";
import { createCurlPackage } from "../src/index.ts";

const pkg = createCurlPackage({ fetch, timeoutMs: 1000 });
const installed: PackageProgram = pkg.programs[0]!;
// @ts-expect-error Host commands cannot disguise a dummy Wasm source as the adapter.
const wasm: PackageProgram = { ...installed, source: async () => new Uint8Array() };
// @ts-expect-error Host commands cannot select an interpreter.
const script: PackageProgram = {
  ...installed,
  script: { interpreter: "/bin/bun", source: async () => "" },
};

test("curl uses the merged command variant without Wasm or an interpreter", () => {
  expect(installed.path).toBe("/usr/bin/curl");
  expect("command" in installed).toBe(true);
  expect("wasm" in installed).toBe(false);
  expect("script" in installed).toBe(false);
  void [wasm, script];
});

test("the package rejects an unbounded deadline before registration", () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 2147483648]) {
    expect(() => createCurlPackage({ fetch, timeoutMs })).toThrow("finite positive");
  }
});
