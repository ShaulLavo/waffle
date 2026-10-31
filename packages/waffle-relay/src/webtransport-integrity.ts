import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "./tcp-protocol.js";

// Digests of the addon inside the checksum-verified public v1.6.11 release archives.
const nativeDigests = new Map([
  ["linux-x64", "5592208da56aee0f53615b8d8c5d57c99a87618593c6343787ac9f92761daf1d"],
  ["linux-arm64", "1671ad318da062eac25cafbb43814041aa3bb5b1550b72a8d78c62ef97b6905e"],
  ["darwin-arm64", "e299c7593424dd24a2624b3514137aca8e10943d845b0f41d89561c2a7f3225f"],
]);
export async function verifyNativeInstallation(): Promise<void> {
  const expected = nativeDigests.get(`${process.platform}-${process.arch}`);
  if (!expected) throw new Error("No verified WebTransport prebuild for this platform");
  const main = dirname(
    dirname(fileURLToPath(import.meta.resolve("@fails-components/webtransport"))),
  );
  const native = dirname(
    dirname(
      fileURLToPath(import.meta.resolve("@fails-components/webtransport-transport-http3-quiche")),
    ),
  );
  await Promise.all([main, native].map(requirePinnedVersion));
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(join(native, "build/Release/webtransport.node")))
    digest.update(chunk);
  if (digest.digest("hex") !== expected) throw new Error("WebTransport native checksum mismatch");
}
async function requirePinnedVersion(root: string): Promise<void> {
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!record(metadata) || metadata.version !== "1.6.11")
    throw new Error("WebTransport requires the exact 1.6.11 package pair");
}
