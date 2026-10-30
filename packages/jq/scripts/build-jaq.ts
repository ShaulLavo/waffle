import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";
import {
  familyRecipe,
  packageRoot,
  releaseDirectory,
  source,
  targetDirectory,
  workspaceRoot,
} from "./build-config.ts";
import { generateJqNotices } from "./notices.ts";

export { packageRoot, source, workspaceRoot } from "./build-config.ts";

interface SourceLock {
  readonly upstream: {
    readonly revision: string;
    readonly archive: string;
    readonly archiveSha256: string;
  };
}

export const sourceLock = JSON.parse(
  readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"),
) as SourceLock;
const patch = resolve(packageRoot, "patches/jaq-wasi.patch");
const receipt = resolve(source, ".waffle-source");
const guest = resolve(releaseDirectory, "jaq.wasm");
const sourceIdentity = createHash("sha256")
  .update(sourceLock.upstream.revision)
  .update(readFileSync(patch))
  .digest("hex");

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => unknown;
export type BuildEnvironment = (recipe: WasiBuildRecipe, target: string) => NodeJS.ProcessEnv;

export interface JqBuildOptions {
  readonly execute?: Execute;
  readonly environment?: BuildEnvironment;
  readonly verifier?: typeof verifyWasiGuest;
  readonly prepare?: () => Promise<void>;
}

async function downloadSource(): Promise<Uint8Array> {
  const response = await fetch(sourceLock.upstream.archive);
  assert.ok(response.ok, `jaq source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, sourceLock.upstream.archiveSha256, "jaq source archive checksum");
  return bytes;
}

function stageWorkspaceLicenses(root: string) {
  const crates = ["jaq", "jaq-all", "jaq-core", "jaq-fmts", "jaq-json", "jaq-std"];
  for (const crate of crates) {
    copyFileSync(resolve(root, "LICENSE-MIT"), resolve(root, crate, "LICENSE-MIT"));
  }
}

export async function prepareJaqSource() {
  if (existsSync(receipt)) {
    assert.equal(readFileSync(receipt, "utf8"), sourceIdentity);
    stageWorkspaceLicenses(source);
    return;
  }
  assert.ok(!existsSync(source), `Unverified jaq source directory: ${source}`);
  const bytes = await downloadSource();
  const build = resolve(packageRoot, ".build");
  mkdirSync(build, { recursive: true });
  const archive = resolve(build, "jaq.tar.gz");
  const scratch = mkdtempSync(resolve(build, "jaq-source-"));
  writeFileSync(archive, bytes);
  try {
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", scratch]);
    execFileSync("patch", ["--batch", "--forward", "-p1", "-d", scratch], {
      input: readFileSync(patch),
    });
    stageWorkspaceLicenses(scratch);
    mkdirSync(dirname(source), { recursive: true });
    renameSync(scratch, source);
    writeFileSync(receipt, sourceIdentity);
  } finally {
    rmSync(archive, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function buildJq(options: JqBuildOptions = {}) {
  const prepare = options.prepare ?? prepareJaqSource;
  const execute = options.execute ?? execFileSync;
  const environment = options.environment ?? wasiBuildEnvironment;
  const verifier = options.verifier ?? verifyWasiGuest;
  await prepare();
  execute(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      resolve(source, "Cargo.toml"),
      "--package",
      "jaq",
      "--no-default-features",
      "-j2",
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...environment(familyRecipe, targetDirectory),
        CARGO_PROFILE_RELEASE_DEBUG: "0",
        CARGO_PROFILE_RELEASE_LTO: "fat",
        CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
        CARGO_PROFILE_RELEASE_PANIC: "abort",
        CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
      },
      stdio: "inherit",
    },
  );
  verifier(guest);
}

export function stageJq() {
  const raw = readFileSync(guest);
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  const destination = resolve(packageRoot, "dist/jq.wasm");
  stageProgram(guest, destination);
  const stripped = readFileSync(destination);
  const compressed = brotliCompressSync(stripped, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  writeFileSync(`${destination}.br`, compressed);
  const sizes = {
    schemaVersion: 1,
    upstreamRevision: sourceLock.upstream.revision,
    rawBytes: raw.length,
    strippedBytes: stripped.length,
    brotliBytes: compressed.length,
    strippedSha256: createHash("sha256").update(stripped).digest("hex"),
  };
  writeFileSync(resolve(packageRoot, "dist/jq.sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`);
  generateJqNotices();
  return sizes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildJq();
  console.log(JSON.stringify(stageJq()));
}
