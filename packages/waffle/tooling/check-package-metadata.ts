import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRuntimeManifest } from "./host-interface.ts";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assertRuntimeManifest(manifest, "packages/waffle/package.json");
console.log("Waffle runtime host-interface metadata: pass");
