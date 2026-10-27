// Run only in the Rust producer, never package/browser jobs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const metadata: unknown = JSON.parse(
  execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
    cwd: root,
    encoding: "utf8",
  }),
);
assert(
  metadata !== null &&
    typeof metadata === "object" &&
    "packages" in metadata &&
    "workspace_members" in metadata,
);
assert(Array.isArray(metadata.packages) && Array.isArray(metadata.workspace_members));
assert.equal(metadata.workspace_members.length, 1);
const network: unknown = metadata.packages.find(
  (pkg: unknown) =>
    pkg !== null && typeof pkg === "object" && "name" in pkg && pkg.name === "waffle-tcp",
);
assert(
  network !== null &&
    typeof network === "object" &&
    "targets" in network &&
    Array.isArray(network.targets),
);
assert(
  network.targets.some(
    (target: unknown) =>
      target !== null &&
      typeof target === "object" &&
      "crate_types" in target &&
      Array.isArray(target.crate_types) &&
      target.crate_types.includes("cdylib"),
  ),
);
const toolchain = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
assert.match(toolchain, /channel = "1\.98\.1"/);
assert.match(toolchain, /"wasm32-unknown-unknown"/);
const tree = execFileSync(
  "cargo",
  [
    "tree",
    "--locked",
    "-p",
    "waffle-tcp",
    "--target",
    "wasm32-unknown-unknown",
    "--edges",
    "normal",
  ],
  { cwd: root, encoding: "utf8" },
);
assert(!/socket2|libc|wasi/.test(tree), tree);
console.log("Pinned workspace cdylib and WASM dependency isolation verified");
