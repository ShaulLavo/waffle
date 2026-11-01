import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { verifiedThreadFixture } from "../scripts/build-thread-fixture.js";

export const RUNTIME_SOURCE_COMMIT = "9a4925903d856043a353a1d723cf4cdea6bf6452";
export const RUNTIME_FIXTURE_SHA256 =
  "410f9f16ee994fd58a9e3e3382fbf0c092d5231518e9d6a21360582ca402fa40";
export const RUNTIME_RECEIPT_SHA256 =
  "9e3d7d484bf9d2d933d30919edd660e88c19e6f2858acf2485bd6d5abe46b4eb";

export const runtimeSafariSources = {
  "/runtime-page.js": new URL("./threads-runtime-browser.ts", import.meta.url).pathname,
  "/fs-worker.js": new URL("../browser/fs-worker.ts", import.meta.url).pathname,
  "/preview1-worker.js": new URL("../browser/preview1-worker.ts", import.meta.url).pathname,
  "/thread-barrier.js": new URL("./threads-runtime-service-barrier.ts", import.meta.url).pathname,
  "/thread-service.js": new URL("../thread/service-worker.ts", import.meta.url).pathname,
  "/thread-guest.js": new URL("../thread/guest-bootstrap.ts", import.meta.url).pathname,
} as const;

export type RuntimeSafariManifest = {
  readonly schema: 1;
  readonly source: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly receiptSha256: string;
  readonly fixtureSha256: string;
  readonly assets: readonly { readonly path: string; readonly sha256: string }[];
  readonly runnerSha256: string;
};

const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected packet manifest object");
  return Object.fromEntries(Object.entries(value));
}

function gitOutput(args: readonly string[]): string {
  const result = Bun.spawnSync(["git"].concat(args), { cwd: import.meta.dir, stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

async function sourceFiles(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const root = resolve(import.meta.dir, "../../..");
  for (const source of Object.values(runtimeSafariSources)) {
    const path = resolve(import.meta.dir, source);
    result[relative(root, path)] = digest(new Uint8Array(await Bun.file(path).arrayBuffer()));
  }
  return result;
}

async function buildBrowserAsset(source: string): Promise<Uint8Array> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, source)],
    target: "browser",
  });
  if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs, `bundle ${source}`);
  return new Uint8Array(await build.outputs[0].arrayBuffer());
}

function assertPinnedSource(): void {
  const excluded = ["packet.ts", "runner.ts", "runner.test.ts"].map(
    (name) => `:(exclude)packages/waffle/tests/threads-runtime-safari-${name}`,
  );
  const args = ["diff", "--quiet", RUNTIME_SOURCE_COMMIT, "--", "."].concat(excluded);
  if (Bun.spawnSync(["git"].concat(args), { cwd: import.meta.dir }).exitCode !== 0)
    throw new Error("Runtime Safari packet requires unchanged pinned production source");
  if (gitOutput(["merge-base", RUNTIME_SOURCE_COMMIT, "HEAD"]) !== RUNTIME_SOURCE_COMMIT)
    throw new Error(`Runtime Safari packet requires source ${RUNTIME_SOURCE_COMMIT}`);
}

export async function prepareThreadsRuntimeSafari(
  directory: string,
  receiptDirectory: string,
): Promise<RuntimeSafariManifest> {
  assertPinnedSource();
  const wasm = verifiedThreadFixture(receiptDirectory);
  const receiptPath = join(receiptDirectory, "threads.receipt.json");
  const receipt = new Uint8Array(await Bun.file(receiptPath).arrayBuffer());
  const fixtureSha256 = digest(wasm);
  const receiptSha256 = digest(receipt);
  if (fixtureSha256 !== RUNTIME_FIXTURE_SHA256) throw new Error("producer artifact digest changed");
  if (receiptSha256 !== RUNTIME_RECEIPT_SHA256) throw new Error("producer receipt digest changed");
  await mkdir(directory);
  const assets: { path: string; sha256: string }[] = [];
  for (const [url, source] of Object.entries(runtimeSafariSources)) {
    const bytes = await buildBrowserAsset(source);
    const path = url.slice(1);
    await Bun.write(join(directory, path), bytes);
    assets.push({ path, sha256: digest(bytes) });
  }
  await Bun.write(join(directory, "threads.wasm"), wasm);
  await copyFile(receiptPath, join(directory, "threads.receipt.json"));
  const runner = await Bun.build({
    entrypoints: [new URL("./threads-runtime-safari-runner.ts", import.meta.url).pathname],
    target: "bun",
  });
  if (!runner.success || !runner.outputs[0])
    throw new AggregateError(runner.logs, "Runtime Safari runner bundle");
  const runnerBytes = new Uint8Array(await runner.outputs[0].arrayBuffer());
  await Bun.write(join(directory, "runner.mjs"), runnerBytes);
  const manifest: RuntimeSafariManifest = {
    schema: 1,
    source: RUNTIME_SOURCE_COMMIT,
    sourceFiles: await sourceFiles(),
    receiptSha256,
    fixtureSha256,
    assets,
    runnerSha256: digest(runnerBytes),
  };
  await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function assertRuntimeSafariPacket(directory: string): Promise<RuntimeSafariManifest> {
  const raw = record(await Bun.file(join(directory, "manifest.json")).json());
  if (raw.schema !== 1 || typeof raw.source !== "string")
    throw new Error("invalid Runtime Safari packet manifest");
  if (typeof raw.receiptSha256 !== "string" || typeof raw.fixtureSha256 !== "string")
    throw new Error("invalid Runtime Safari packet digests");
  if (!Array.isArray(raw.assets) || typeof raw.runnerSha256 !== "string")
    throw new Error("invalid Runtime Safari packet assets");
  const assets = raw.assets.map((value) => {
    const item = record(value);
    if (typeof item.path !== "string" || typeof item.sha256 !== "string")
      throw new Error("invalid Runtime Safari packet asset");
    return { path: item.path, sha256: item.sha256 };
  });
  const sourceFilesValue = record(raw.sourceFiles);
  const sourceFiles: Record<string, string> = {};
  for (const [path, value] of Object.entries(sourceFilesValue)) {
    if (typeof value !== "string") throw new Error("invalid Runtime Safari source digest");
    sourceFiles[path] = value;
  }
  const manifest: RuntimeSafariManifest = {
    schema: 1,
    source: raw.source,
    sourceFiles,
    receiptSha256: raw.receiptSha256,
    fixtureSha256: raw.fixtureSha256,
    assets,
    runnerSha256: raw.runnerSha256,
  };
  if (manifest.schema !== 1 || manifest.source !== RUNTIME_SOURCE_COMMIT)
    throw new Error("Runtime Safari packet source mismatch");
  if (manifest.fixtureSha256 !== RUNTIME_FIXTURE_SHA256)
    throw new Error("Runtime Safari packet artifact mismatch");
  if (manifest.receiptSha256 !== RUNTIME_RECEIPT_SHA256)
    throw new Error("Runtime Safari packet receipt mismatch");
  const expected = Object.keys(runtimeSafariSources).map((path) => path.slice(1));
  if (
    manifest.assets.length !== expected.length ||
    new Set(manifest.assets.map((asset) => asset.path)).size !== expected.length ||
    manifest.assets.some((asset) => !expected.includes(asset.path))
  )
    throw new Error("Runtime Safari packet asset allowlist mismatch");
  const allowed = new Set(
    expected.concat(["manifest.json", "runner.mjs", "threads.wasm", "threads.receipt.json"]),
  );
  const entries = await readdir(directory);
  if (entries.length !== allowed.size || entries.some((entry) => !allowed.has(entry)))
    throw new Error("Runtime Safari packet file allowlist mismatch");
  for (const entry of entries) {
    if (!(await lstat(join(directory, entry))).isFile())
      throw new Error("Runtime Safari packet requires ordinary files");
  }
  for (const asset of manifest.assets) {
    const bytes = new Uint8Array(await Bun.file(join(directory, asset.path)).arrayBuffer());
    if (digest(bytes) !== asset.sha256) throw new Error(`packet digest mismatch ${asset.path}`);
  }
  if (
    digest(new Uint8Array(await Bun.file(join(directory, "threads.wasm")).arrayBuffer())) !==
    manifest.fixtureSha256
  )
    throw new Error("fixture digest mismatch");
  if (
    digest(
      new Uint8Array(await Bun.file(join(directory, "threads.receipt.json")).arrayBuffer()),
    ) !== manifest.receiptSha256
  )
    throw new Error("receipt digest mismatch");
  if (
    digest(new Uint8Array(await Bun.file(join(directory, "runner.mjs")).arrayBuffer())) !==
    manifest.runnerSha256
  )
    throw new Error("runner digest mismatch");
  return manifest;
}
