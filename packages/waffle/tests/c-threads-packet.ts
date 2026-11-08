import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedCThreadFixture } from "../scripts/build-c-thread-fixture.js";
import { cThreadArtifactSha256, cThreadReceiptSha256 } from "./c-threads-runtime-browser.js";

export const cThreadBrowserSources = {
  "c-positive.js": fileURLToPath(new URL("./c-threads-positive-worker.ts", import.meta.url)),
  "runtime-page.js": fileURLToPath(new URL("./c-threads-runtime-browser.ts", import.meta.url)),
  "fs-worker.js": fileURLToPath(new URL("../browser/fs-worker.ts", import.meta.url)),
  "preview1-worker.js": fileURLToPath(new URL("../browser/preview1-worker.ts", import.meta.url)),
  "thread-service.js": fileURLToPath(new URL("../thread/service-worker.ts", import.meta.url)),
  "thread-guest.js": fileURLToPath(new URL("./c-threads-runtime-guest.ts", import.meta.url)),
};
export const cThreadSafariRunner = fileURLToPath(
  new URL("./c-threads-safari-runner.ts", import.meta.url),
);
const packetDigest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const assetNames = Object.keys(cThreadBrowserSources).concat([
  "c-threads.wasm",
  "c-threads.receipt.json",
  "runner.mjs",
]);
interface CThreadsPacket {
  schema: 1;
  source: string;
  sourceTree: string;
  artifactSha256: string;
  receiptSha256: string;
  assets: { path: string; sha256: string }[];
}
function git(args: string[]) {
  const result = Bun.spawnSync(["git"].concat(args), { cwd: import.meta.dir });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}
async function bundle(source: string, target: "browser" | "bun") {
  const result = await Bun.build({ entrypoints: [source], target });
  if (!result.success || result.outputs.length !== 1)
    throw new AggregateError(result.logs, `C packet build ${source}`);
  return new Uint8Array(await result.outputs[0]!.arrayBuffer());
}
export async function prepareCThreadsPacket(directory: string, artifactDirectory: string) {
  if (git(["status", "--porcelain"])) throw new Error("C packet requires a clean source commit");
  const wasm = verifiedCThreadFixture(artifactDirectory);
  const receipt = await readFile(join(artifactDirectory, "c-threads.receipt.json"));
  if (
    packetDigest(wasm) !== cThreadArtifactSha256 ||
    packetDigest(receipt) !== cThreadReceiptSha256
  )
    throw new Error("C packet artifact or receipt changed");
  await mkdir(directory);
  for (const [path, source] of Object.entries(cThreadBrowserSources))
    await Bun.write(join(directory, path), await bundle(source, "browser"));
  await Bun.write(join(directory, "c-threads.wasm"), wasm);
  await copyFile(
    join(artifactDirectory, "c-threads.receipt.json"),
    join(directory, "c-threads.receipt.json"),
  );
  await Bun.write(join(directory, "runner.mjs"), await bundle(cThreadSafariRunner, "bun"));
  const assets = [];
  for (const path of assetNames)
    assets.push({ path, sha256: packetDigest(await readFile(join(directory, path))) });
  const manifest: CThreadsPacket = {
    schema: 1,
    source: git(["rev-parse", "HEAD"]),
    sourceTree: git(["rev-parse", "HEAD^{tree}"]),
    artifactSha256: cThreadArtifactSha256,
    receiptSha256: cThreadReceiptSha256,
    assets,
  };
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  await Bun.write(join(directory, "manifest.json"), serialized);
  return { manifest, manifestSha256: packetDigest(serialized) };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid C packet object");
  return Object.fromEntries(Object.entries(value));
}
export async function readCThreadsPacket(directory: string, expectedManifest: string) {
  const serialized = await readFile(join(directory, "manifest.json"));
  if (packetDigest(serialized) !== expectedManifest)
    throw new Error("C packet manifest digest mismatch");
  const value = record(JSON.parse(serialized.toString()));
  if (
    value.schema !== 1 ||
    typeof value.source !== "string" ||
    typeof value.sourceTree !== "string" ||
    value.artifactSha256 !== cThreadArtifactSha256 ||
    value.receiptSha256 !== cThreadReceiptSha256 ||
    !Array.isArray(value.assets)
  )
    throw new Error("invalid C packet identity");
  const assets = value.assets.map((entry) => {
    const item = record(entry);
    if (typeof item.path !== "string" || typeof item.sha256 !== "string")
      throw new Error("invalid C packet asset");
    return { path: item.path, sha256: item.sha256 };
  });
  if (
    assets.length !== assetNames.length ||
    new Set(assets.map((item) => item.path)).size !== assetNames.length ||
    assets.some((item) => !assetNames.includes(item.path))
  )
    throw new Error("C packet asset allowlist mismatch");
  const files = await readdir(directory);
  if (
    files.length !== assetNames.length + 1 ||
    files.some((name) => name !== "manifest.json" && !assetNames.includes(name))
  )
    throw new Error("C packet file allowlist mismatch");
  for (const name of files) {
    if (!(await lstat(join(directory, name))).isFile())
      throw new Error("C packet requires ordinary files");
  }
  for (const asset of assets) {
    if (packetDigest(await readFile(join(directory, asset.path))) !== asset.sha256)
      throw new Error(`C packet digest mismatch ${asset.path}`);
  }
  const manifest: CThreadsPacket = {
    schema: 1,
    source: value.source,
    sourceTree: value.sourceTree,
    artifactSha256: cThreadArtifactSha256,
    receiptSha256: cThreadReceiptSha256,
    assets,
  };
  return manifest;
}
