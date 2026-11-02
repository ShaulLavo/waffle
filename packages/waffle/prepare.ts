import { existsSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
if (typeof Bun.Transpiler !== "function") {
  throw new Error(
    "Waffle prepare requires Bun's TypeScript build tools; install with Bun rather than a package manager that skips prepare scripts.",
  );
}
const { buildNodeModules } = await import("./build");
await buildNodeModules(root);
const required = [
  "dist/index.js",
  "tooling/program/program-build-tools.ts",
  "dist/tooling/program/program-build-tools.js",
  "dist/browser/net/network.wasm",
  "dist/core/index.js",
  "dist/core/memory-views.js",
  "dist/fs/index.js",
  "dist/proc/index.js",
  "dist/link/index.js",
];
const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length)
  throw new Error(`Waffle prepare did not emit required Node entry points: ${missing.join(", ")}`);
