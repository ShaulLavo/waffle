import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildConfiguration,
  wasiSysrootCommand,
  wasiTarget,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";

export const packageRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(packageRoot, "../..");
export const targetDirectory = ".build/grep";
export const releaseDirectory = resolve(workspaceRoot, targetDirectory, wasiTarget, "release");
export const familyRecipe = {
  root: workspaceRoot,
  waffle: resolve(workspaceRoot, "packages/waffle"),
} satisfies WasiBuildRecipe;

export const sourceFiles = ["grep.c", "file.c", "queue.c", "util.c"] as const;
export const patchPath = resolve(packageRoot, "patches/freebsd-grep-wasi.patch");

export interface GrepSourceLock {
  readonly upstream: {
    readonly name: string;
    readonly version: string;
    readonly repository: string;
    readonly revision: string;
    readonly baseUrl: string;
    readonly licensePath: string;
    readonly licenseSha256: string;
    readonly files: Readonly<Record<string, { readonly sha256: string }>>;
  };
}

export type Execute = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Uint8Array },
) => Buffer;

export interface GrepBuildOptions {
  readonly nativeOnly?: boolean;
  readonly sourceDir?: string;
  readonly execute?: Execute;
  readonly fetchFile?: (url: string) => Promise<Uint8Array>;
  readonly verifier?: typeof verifyWasiGuest;
  readonly sysrootCommand?: typeof wasiSysrootCommand;
  readonly buildConfig?: typeof wasiBuildConfiguration;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function defaultExecute(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Uint8Array },
): Buffer {
  return execFileSync("timeout", ["--kill-after=2s", "600s", command].concat(args), {
    cwd: options.cwd,
    input: options.input,
    env: options.env ?? { ...process.env, TMPDIR: process.env.GREP_SCRATCH_ROOT ?? "/work/tmp" },
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function defaultFetchFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `FreeBSD grep source download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function readSourceLock(): GrepSourceLock {
  const raw: unknown = JSON.parse(readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"));
  assert.ok(raw && typeof raw === "object" && "upstream" in raw);
  const upstream = raw.upstream;
  assert.ok(upstream && typeof upstream === "object");
  assert.ok(
    "name" in upstream &&
      typeof upstream.name === "string" &&
      "version" in upstream &&
      typeof upstream.version === "string" &&
      "repository" in upstream &&
      typeof upstream.repository === "string" &&
      "revision" in upstream &&
      typeof upstream.revision === "string" &&
      /^[a-f0-9]{40}$/.test(upstream.revision) &&
      "baseUrl" in upstream &&
      typeof upstream.baseUrl === "string" &&
      "licensePath" in upstream &&
      typeof upstream.licensePath === "string" &&
      "licenseSha256" in upstream &&
      typeof upstream.licenseSha256 === "string" &&
      "files" in upstream &&
      upstream.files &&
      typeof upstream.files === "object",
  );
  assert.equal(
    upstream.baseUrl,
    `https://raw.githubusercontent.com/freebsd/freebsd-src/${upstream.revision}/usr.bin/grep`,
  );
  const files: Record<string, { readonly sha256: string }> = {};
  for (const [name, entry] of Object.entries(upstream.files)) {
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "sha256" in entry &&
        typeof entry.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(entry.sha256),
      `invalid sha256 for ${name}`,
    );
    files[name] = { sha256: entry.sha256 };
  }
  return {
    upstream: {
      name: upstream.name,
      version: upstream.version,
      repository: upstream.repository,
      revision: upstream.revision,
      baseUrl: upstream.baseUrl,
      licensePath: upstream.licensePath,
      licenseSha256: upstream.licenseSha256,
      files,
    },
  };
}

async function prepareSource(
  work: string,
  lock: GrepSourceLock,
  execute: Execute,
  fetchFile: (url: string) => Promise<Uint8Array>,
): Promise<string> {
  const source = resolve(work, "source");
  mkdirSync(source, { recursive: true });
  const entries = Object.entries(lock.upstream.files);
  const downloaded = await Promise.all(
    entries.map(async ([name, meta]) => {
      const bytes = await fetchFile(`${lock.upstream.baseUrl}/${name}`);
      assert.equal(sha256(bytes), meta.sha256, `FreeBSD grep checksum mismatch: ${name}`);
      return { name, bytes };
    }),
  );
  for (const item of downloaded) writeFileSync(resolve(source, item.name), item.bytes);
  assert.equal(
    sha256(readFileSync(resolve(packageRoot, lock.upstream.licensePath))),
    lock.upstream.licenseSha256,
    lock.upstream.licensePath,
  );
  execute("patch", ["--batch", "--forward", "-p1"], {
    cwd: source,
    input: readFileSync(patchPath),
  });
  return source;
}

function buildNative(source: string, lock: GrepSourceLock, execute: Execute): void {
  const output = resolve(packageRoot, ".build/native/grep");
  mkdirSync(dirname(output), { recursive: true });
  execute("cc", ["-D_GNU_SOURCE", "-O2", "-o", output].concat(sourceFiles), { cwd: source });
  writeFileSync(
    `${output}.json`,
    JSON.stringify(
      {
        revision: lock.upstream.revision,
        patchSha256: sha256(readFileSync(patchPath)),
        executableSha256: sha256(readFileSync(output)),
        compiler: execute("cc", ["--version"], { cwd: source }).toString().split("\n")[0],
      },
      null,
      2,
    ) + "\n",
  );
}

function buildWasi(
  source: string,
  execute: Execute,
  verifier: typeof verifyWasiGuest,
  sysrootCommand: typeof wasiSysrootCommand,
  buildConfig: typeof wasiBuildConfiguration,
): { guest: string; sdk: string; identity: string; sysroot: string; linker: string } {
  const config = buildConfig(familyRecipe);
  const [command, args] = sysrootCommand(familyRecipe);
  execute(command, args, { cwd: familyRecipe.root });
  const guest = resolve(releaseDirectory, "grep.wasm");
  mkdirSync(dirname(guest), { recursive: true });
  execute(
    config.linker,
    [
      `--target=${wasiTarget}`,
      `--sysroot=${config.sysroot}`,
      "-D_GNU_SOURCE",
      "-Oz",
      `-ffile-prefix-map=${source}=freebsd-grep`,
      "-Wl,--max-memory=268435456",
      "-o",
      guest,
    ].concat(sourceFiles),
    { cwd: source },
  );
  verifier(guest, { sdk: config.sdk });
  return {
    guest,
    sdk: config.sdk,
    identity: config.identity,
    sysroot: config.sysroot,
    linker: config.linker,
  };
}

export function stageGrep(sdk?: string) {
  const guest = resolve(releaseDirectory, "grep.wasm");
  const destinations = ["dist", "public/programs"].map((directory) =>
    resolve(packageRoot, directory, "grep.wasm"),
  );
  for (const path of destinations) mkdirSync(resolve(path, ".."), { recursive: true });
  return stageProgram(guest, destinations, sdk ? { sdk } : {});
}

export async function buildGrep(options: GrepBuildOptions = {}): Promise<void> {
  const execute = options.execute ?? defaultExecute;
  const fetchFile = options.fetchFile ?? defaultFetchFile;
  const verifier = options.verifier ?? verifyWasiGuest;
  const sysrootCommand = options.sysrootCommand ?? wasiSysrootCommand;
  const buildConfig = options.buildConfig ?? wasiBuildConfiguration;
  const lock = readSourceLock();
  const scratch = process.env.GREP_SCRATCH_ROOT ?? "/work/tmp";
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(resolve(scratch, "waffle-grep-build-"));
  try {
    const source = options.sourceDir ?? (await prepareSource(work, lock, execute, fetchFile));
    if (options.nativeOnly) {
      buildNative(source, lock, execute);
      return;
    }
    const built = buildWasi(source, execute, verifier, sysrootCommand, buildConfig);
    if (options.execute !== undefined) return;
    const derivation = stageGrep(built.sdk);
    const output = resolve(packageRoot, "dist/grep.wasm");
    const raw = readFileSync(built.guest);
    const stripped = readFileSync(output);
    const compressed = readFileSync(`${output}.br`);
    const gzip = readFileSync(`${output}.gz`);
    const receipt = {
      schemaVersion: 1,
      revision: lock.upstream.revision,
      patchSha256: sha256(readFileSync(patchPath)),
      libcRecipeIdentity: built.identity,
      libcSha256: sha256(readFileSync(resolve(built.sysroot, "lib/wasm32-wasip1/libc.a"))),
      raw: { bytes: raw.length, sha256: sha256(raw) },
      stripped: { bytes: stripped.length, sha256: sha256(stripped) },
      brotli: { bytes: compressed.length, sha256: sha256(compressed) },
      gzip: { bytes: gzip.length, sha256: sha256(gzip) },
      operation: derivation.operation,
      transformer: derivation.transformer,
      compiler: execute(built.linker, ["--version"], { cwd: packageRoot })
        .toString()
        .split("\n")[0],
    };
    writeFileSync(
      resolve(packageRoot, "dist/grep.sizes.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--native"),
  );
  await buildGrep({ nativeOnly: process.argv[2] === "--native" });
}
