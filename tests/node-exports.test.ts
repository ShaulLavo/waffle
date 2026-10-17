import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const specifiers = ["waffle", "waffle/core", "waffle/fs", "waffle/proc", "waffle/interrupt", "waffle/core/memory-views"];

test("Node resolves every documented package entry to prepared JavaScript", () => {
  const root = resolve(import.meta.dir, "..");
  const script = `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);`;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, stdio: "pipe" })).not.toThrow();
});
