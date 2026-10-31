import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stageProgram } from "../tools/program-build-tools.ts";
import { transformationProvenance } from "../tools/program-derivation.ts";
import { programToolSources } from "../packages/waffle/tooling/program-tools-package.ts";
import { cappedWasiFixture } from "../packages/python/scripts/wasi-artifact-fixture.ts";
import { buildNodeModules } from "../packages/waffle/build.ts";

const repository = resolve(import.meta.dirname, "..");
const runtimeVersion: unknown = JSON.parse(
  readFileSync(resolve(repository, "packages/waffle/package.json"), "utf8"),
).version;
if (typeof runtimeVersion !== "string") throw new Error("Runtime fixture needs a package version");
const baseFamilies = ["coreutils", "findutils", "grep", "sed", "ripgrep", "base"];

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root].concat(args), { encoding: "utf8" }).trim();
}

/** Copies the real family sources and writes stand-in prepared outputs into a disposable repo. */
export function preparedFixture(scratch: string, name: string) {
  const root = resolve(scratch, name);
  for (const family of baseFamilies) {
    cpSync(resolve(repository, "packages", family), resolve(root, "packages", family), {
      recursive: true,
      filter: (path) => !/\/(node_modules|dist|\.build|target|\.sources)$/.test(path),
    });
  }
  writeFileSync(resolve(root, ".gitignore"), "dist/\nnode_modules/\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  for (const family of baseFamilies) writeArtifacts(resolve(root, "packages", family));
  return root;
}

function writeArtifacts(packageRoot: string) {
  const recipe = JSON.parse(readFileSync(resolve(packageRoot, "package-artifacts.json"), "utf8"));
  for (const file of recipe.files as string[]) {
    const path = resolve(packageRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    if (file.endsWith("-program.json")) continue;
    if (!file.endsWith(".wasm")) {
      writeFileSync(path, `stand-in notice for ${file}\n`);
      continue;
    }
    const input = resolve(packageRoot, ".build/fixture-input.wasm");
    mkdirSync(dirname(input), { recursive: true });
    writeFileSync(input, cappedWasiFixture);
    stageProgram(input, path);
    rmSync(input);
  }
}

export async function prepareRuntimeFixture(scratch: string) {
  const root = resolve(scratch, "runtime-source");
  cpSync(resolve(repository, "packages/waffle"), root, {
    recursive: true,
    filter: (path) => !/\/(node_modules|dist|\.build|target|\.sources)$/.test(path),
  });
  const tools = resolve(root, "tooling/program");
  mkdirSync(tools, { recursive: true });
  for (const file of programToolSources)
    cpSync(resolve(repository, "tools", file), resolve(tools, file));
  writeFileSync(
    resolve(tools, "program-transformer.json"),
    JSON.stringify(transformationProvenance()) + "\n",
  );
  // This suite executes package metadata, not networking. Keep its network fixture explicit.
  writeFileSync(
    resolve(root, "browser/net/network.wasm"),
    Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
  );
  await buildNodeModules(root, async () => {});
  const destination = resolve(scratch, "runtime-archive");
  mkdirSync(destination);
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--destination", destination], {
    cwd: root,
    env: { ...process.env, WAFFLE_NETWORK_PREBUILT: "1" },
    stdio: "pipe",
  });
  const archive = resolve(destination, `waffle-${runtimeVersion}.tgz`);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, sha256: digest, version: String(runtimeVersion) };
}
