import { resolve } from "node:path";
import { basePackages } from "@waffle-os/base";
import assert from "node:assert/strict";
import { runFamilyBrowser } from "./family-browser-runner.ts";

const root = resolve(import.meta.dirname, "..");
const assets = new Map(
  basePackages.flatMap((family) =>
    family.programs.map((program) => {
      assert.ok(program.wasm);
      return [program.path.split("/").at(-1) + ".wasm", program.wasm] as const;
    }),
  ),
);
console.log(
  JSON.stringify(
    await runFamilyBrowser({
      entry: resolve(root, "tools/family-browser-app.ts"),
      assets,
      fsWorker: resolve(root, "packages/waffle/browser/fs-worker.ts"),
      preview1Worker: resolve(root, "packages/waffle/browser/preview1-worker.ts"),
      engine: "chromium",
    }),
  ),
);
