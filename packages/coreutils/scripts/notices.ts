import { resolve } from "node:path";
import { generateRustNotices } from "../../../tools/program-notices.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const root = resolve(import.meta.dirname, "..");
execFileSync("node", ["scripts/notices.mjs"], { cwd: root, stdio: "inherit" });
generateRustNotices({
  root,
  packages: [
    "waffle-coreutils",
    "waffle-cut",
    "waffle-tr",
    "waffle-wc",
    "waffle-clear",
    "waffle-echo",
  ],
  features: "cooperative-wasi",
  prefix: readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8"),
});
