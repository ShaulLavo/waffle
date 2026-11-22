import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
}

run("bunx", ["changeset", "version"]);
run("bun", ["install", "--lockfile-only", "--ignore-scripts"]);
