import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, lstat, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { verifiedThreadFixture } from "../scripts/build-thread-fixture.js";

declare const THREAD_RUNTIME_PACKET_IDENTITY: RuntimePacketIdentity | undefined;

export const runtimeSafariSources = {
  "/runtime-page.js": new URL("./threads-runtime-browser.ts", import.meta.url).pathname,
  "/fs-worker.js": new URL("../browser/fs-worker.ts", import.meta.url).pathname,
  "/preview1-worker.js": new URL("../browser/preview1-worker.ts", import.meta.url).pathname,
  "/thread-barrier.js": new URL("./threads-runtime-service-barrier.ts", import.meta.url).pathname,
  "/thread-service.js": new URL("../thread/service-worker.ts", import.meta.url).pathname,
  "/thread-guest.js": new URL("../thread/guest-bootstrap.ts", import.meta.url).pathname,
} as const;

export const runtimeNativeSources = {
  ...runtimeSafariSources,
  "/page.js": new URL("./page-runner/threads-runtime-page.ts", import.meta.url).pathname,
};

export type RuntimePacketIdentity = {
  readonly source: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly receiptSha256: string;
  readonly fixtureSha256: string;
};

export type RuntimeSafariManifest = {
  readonly schema: 1;
  readonly source: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly receiptSha256: string;
  readonly fixtureSha256: string;
  readonly assets: readonly { readonly path: string; readonly sha256: string }[];
  readonly runnerSha256: string;
  readonly nativeRunnerSha256: string;
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
  for (const source of Object.values(runtimeNativeSources)) {
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

export async function runtimeFixture(directory: string) {
  const wasm = verifiedThreadFixture(directory);
  const receipt = new Uint8Array(
    await Bun.file(join(directory, "threads.receipt.json")).arrayBuffer(),
  );
  return { wasm, fixtureSha256: digest(wasm), receiptSha256: digest(receipt) };
}

async function currentIdentity(receiptDirectory: string) {
  const fixture = await runtimeFixture(receiptDirectory);
  const identity: RuntimePacketIdentity = {
    source: gitOutput(["rev-parse", "HEAD"]),
    sourceFiles: await sourceFiles(),
    fixtureSha256: fixture.fixtureSha256,
    receiptSha256: fixture.receiptSha256,
  };
  return { identity, wasm: fixture.wasm };
}

export async function prepareThreadsRuntimeSafari(
  directory: string,
  receiptDirectory: string,
): Promise<RuntimeSafariManifest> {
  const { identity, wasm } = await currentIdentity(receiptDirectory);
  await mkdir(directory);
  try {
    return await writeRuntimePacket(directory, receiptDirectory, identity, wasm);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function writeRuntimePacket(
  directory: string,
  receiptDirectory: string,
  identity: RuntimePacketIdentity,
  wasm: Uint8Array,
): Promise<RuntimeSafariManifest> {
  const { source, fixtureSha256, receiptSha256 } = identity;
  const receiptPath = join(receiptDirectory, "threads.receipt.json");
  const assets: { path: string; sha256: string }[] = [];
  for (const [url, source] of Object.entries(runtimeNativeSources)) {
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
    define: { THREAD_RUNTIME_PACKET_IDENTITY: JSON.stringify(identity) },
  });
  if (!runner.success || !runner.outputs[0])
    throw new AggregateError(runner.logs, "Runtime Safari runner bundle");
  const runnerBytes = new Uint8Array(await runner.outputs[0].arrayBuffer());
  await Bun.write(join(directory, "runner.mjs"), runnerBytes);
  const native = await Bun.build({
    entrypoints: [new URL("./page-runner/threads-runtime-native.ts", import.meta.url).pathname],
    target: "bun",
    define: { THREAD_RUNTIME_PACKET_IDENTITY: JSON.stringify(identity) },
  });
  if (!native.success || !native.outputs[0])
    throw new AggregateError(native.logs, "Runtime iOS runner bundle");
  const nativeBytes = new Uint8Array(await native.outputs[0].arrayBuffer());
  await Bun.write(join(directory, "ios-runner.mjs"), nativeBytes);
  const manifest: RuntimeSafariManifest = {
    schema: 1,
    source,
    sourceFiles: identity.sourceFiles,
    receiptSha256,
    fixtureSha256,
    assets,
    runnerSha256: digest(runnerBytes),
    nativeRunnerSha256: digest(nativeBytes),
  };
  await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function assertRuntimeSafariPacket(
  directory: string,
  expectedIdentity?: RuntimePacketIdentity,
): Promise<RuntimeSafariManifest> {
  const raw = record(await Bun.file(join(directory, "manifest.json")).json());
  if (raw.schema !== 1 || typeof raw.source !== "string")
    throw new Error("invalid Runtime Safari packet manifest");
  if (typeof raw.receiptSha256 !== "string" || typeof raw.fixtureSha256 !== "string")
    throw new Error("invalid Runtime Safari packet digests");
  if (
    !Array.isArray(raw.assets) ||
    typeof raw.runnerSha256 !== "string" ||
    typeof raw.nativeRunnerSha256 !== "string"
  )
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
    nativeRunnerSha256: raw.nativeRunnerSha256,
  };
  if (!/^[a-f0-9]{40}$/.test(manifest.source)) throw new Error("invalid packet source identity");
  const identity =
    expectedIdentity ??
    (typeof THREAD_RUNTIME_PACKET_IDENTITY === "undefined"
      ? (await currentIdentity(directory)).identity
      : THREAD_RUNTIME_PACKET_IDENTITY);
  if (
    identity &&
    JSON.stringify({
      source: manifest.source,
      sourceFiles: manifest.sourceFiles,
      fixtureSha256: manifest.fixtureSha256,
      receiptSha256: manifest.receiptSha256,
    }) !==
      JSON.stringify({
        source: identity.source,
        sourceFiles: identity.sourceFiles,
        fixtureSha256: identity.fixtureSha256,
        receiptSha256: identity.receiptSha256,
      })
  )
    throw new Error("Runtime Safari packet identity mismatch");
  const expected = Object.keys(runtimeNativeSources).map((path) => path.slice(1));
  if (
    manifest.assets.length !== expected.length ||
    new Set(manifest.assets.map((asset) => asset.path)).size !== expected.length ||
    manifest.assets.some((asset) => !expected.includes(asset.path))
  )
    throw new Error("Runtime Safari packet asset allowlist mismatch");
  const allowed = new Set(
    expected.concat([
      "manifest.json",
      "runner.mjs",
      "ios-runner.mjs",
      "threads.wasm",
      "threads.receipt.json",
    ]),
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
  if (
    digest(new Uint8Array(await Bun.file(join(directory, "ios-runner.mjs")).arrayBuffer())) !==
    manifest.nativeRunnerSha256
  )
    throw new Error("native runner digest mismatch");
  return manifest;
}
