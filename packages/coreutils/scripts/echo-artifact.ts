import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  githubIdentity,
  sha256,
  sourceInputs,
  verifyXargsArtifact,
  workspaceRoot,
} from "../../findutils/scripts/xargs-artifact.ts";
import { stripWasmNames, verifyWasiGuest } from "../../../tools/program-build-tools.ts";

const input = process.env.ECHO_XARGS_ARTIFACT;
assert.ok(input, "same-run qualified xargs artifact required");
const xargs = verifyXargsArtifact(input);
const guest = resolve(workspaceRoot, ".build/coreutils/wasm32-wasip1/release/echo.wasm");
verifyWasiGuest(guest);
const bytes = readFileSync(guest);
assert.deepEqual(
  readFileSync(resolve(workspaceRoot, "packages/coreutils/dist/echo.wasm")),
  stripWasmNames(bytes),
);
const proof = {
  schema: "waffle-echo-xargs-qualified-pair/v1",
  identity: githubIdentity(),
  echoInputs: sourceInputs([
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "packages/coreutils/crates/echo",
    "packages/coreutils/scripts/build-echo.ts",
    "packages/coreutils/scripts/build-family.ts",
    "packages/coreutils/scripts/build-config.ts",
    "packages/coreutils/scripts/programs.ts",
    "packages/coreutils/scripts/echo-artifact.ts",
    "packages/coreutils/provenance/echo.source.json",
    "tools/program-build-tools.ts",
    "packages/waffle/scripts/build-wasi-libc.sh",
    "packages/waffle/patches/wasi-libc/preopen-scan.patch",
  ]),
  echoGuest: { bytes: bytes.length, sha256: sha256(bytes) },
  xargs: xargs.receipt,
  acceptance:
    "actual echo WASI direct flags/bytes/closed-fd controls; before127/after0 real xargs pipe; grouping/argv; cancellation after echo output on open input; cleanup",
};
const output = resolve(workspaceRoot, ".build/echo-artifact");
mkdirSync(output, { recursive: true });
copyFileSync(guest, resolve(output, "echo.wasm"));
writeFileSync(resolve(output, "receipt.json"), JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify(proof));
