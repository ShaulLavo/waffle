import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWasiGuest } from "../../../tools/program-build-tools.ts";
import { releaseDirectory, workspaceRoot } from "./build-config.ts";
import { coreutilsNames, verificationOptions } from "./programs.ts";

const receiptName = "source-sha256.txt";
type Verify = typeof verifyWasiGuest;

function receipt(root: string, directory: string, verifier: Verify): string {
  const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.match(source, /^[a-f0-9]{40}$/);
  const hashes = coreutilsNames.map((name) => {
    const path = resolve(directory, `${name}.wasm`);
    verifier(path, verificationOptions(name));
    return `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}.wasm`;
  });
  return [`source ${source}`].concat(hashes).join("\n") + "\n";
}

function copyCoreutils(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const name of coreutilsNames) {
    copyFileSync(resolve(source, `${name}.wasm`), resolve(destination, `${name}.wasm`));
  }
}

export function writeCoreutilsArtifacts(
  root: string,
  release: string,
  output: string,
  verifier: Verify = verifyWasiGuest,
) {
  const contents = receipt(root, release, verifier);
  copyCoreutils(release, output);
  writeFileSync(resolve(output, receiptName), contents);
}

export function stageCoreutilsArtifacts(
  root: string,
  source: string,
  release: string,
  verifier: Verify = verifyWasiGuest,
) {
  assert.equal(
    readFileSync(resolve(source, receiptName), "utf8"),
    receipt(root, source, verifier),
    "Coreutils artifacts must match this exact source and every verified guest hash",
  );
  copyCoreutils(source, release);
  console.log(`Reused verified coreutils artifacts from ${source}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeCoreutilsArtifacts(
    workspaceRoot,
    releaseDirectory,
    resolve(workspaceRoot, ".build/utility-artifacts"),
  );
}
