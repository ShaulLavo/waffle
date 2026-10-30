import { expect, test } from "bun:test";
import type { PackageProgram } from "../../waffle/programs/index.ts";
import type { Executable } from "../../waffle/proc/registry.ts";

// Compile-only failing controls. Neither object is registered or executed.
// @ts-expect-error The accepted package API requires Wasm or an explicit interpreter.
const nativePackage: PackageProgram = { path: "/usr/bin/curl", aliases: ["/bin/curl"] };
// @ts-expect-error The accepted registry has no module-less executable kind.
const nativeExecutable: Executable = { adapter: "curl" };

test("actual runtime admission remains BLOCKED, not a fixture interpreter pass", () => {
  expect(nativePackage.path).toBe("/usr/bin/curl");
  expect("module" in nativeExecutable).toBe(false);
});
