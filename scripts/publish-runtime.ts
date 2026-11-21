import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
}

const networkWasm = resolve(root, "packages/waffle/browser/net/network.wasm");
if (!existsSync(networkWasm)) {
  run("bun", ["run", "build:network"]);
}

const buildEnv = { ...process.env, WAFFLE_NETWORK_PREBUILT: "1" };
run("bun", ["packages/waffle-relay/scripts/prepare-native.ts"], buildEnv);
run("bun", ["run", "prepare:package"], buildEnv);
run("bun", ["run", "--cwd", "packages/waffle", "tooling/check-package-metadata.ts"], buildEnv);
run("bunx", ["changeset", "publish"], { ...buildEnv, NPM_CONFIG_PROVENANCE: "true" });
