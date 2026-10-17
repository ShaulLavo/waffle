import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Node resolves every documented Node package entry to prepared JavaScript", () => {
  const root = resolve(import.meta.dir, "..");
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, Record<string, string>>;
  };
  const entries = Object.entries(metadata.exports);
  const nodeEntries = entries.filter(([, target]) => typeof target.node === "string");
  const browserOnly = entries.filter(([, target]) => target.node === undefined).map(([key]) => key);
  expect(browserOnly).toEqual([
    "./browser/fs-worker",
    "./testing/interrupt-browser-runner-control",
    "./testing/storage-browser",
    "./testing/opfs-storage-browser",
  ]);
  for (const key of browserOnly) {
    for (const target of Object.values(metadata.exports[key]!)) {
      if (target.startsWith("./")) expect(existsSync(resolve(root, target))).toBe(true);
    }
  }
  const specifiers = nodeEntries.map(([key]) => key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`);
  const script = `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);`;
  expect(() => execFileSync("node", ["--input-type=module", "--eval", script], { cwd: root, stdio: "pipe" })).not.toThrow();
  const browserScript = `for (const specifier of ${JSON.stringify(browserOnly.map(key => key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`))}) { try { await import(specifier); throw new Error(\`Node unexpectedly resolved ${"$"}{specifier}\`); } catch (error) { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; } }`;
  expect(() => execFileSync("node", ["--input-type=module", "--eval", browserScript], { cwd: root, stdio: "pipe" })).not.toThrow();
});
