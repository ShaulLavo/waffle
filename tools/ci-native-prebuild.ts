import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { releaseDownload } from "./ci-release-download.ts";

export const nativePrebuild = {
  url: "https://github.com/fails-components/webtransport/releases/download/v1.6.11/webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz",
  sha256: "6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12",
};

export function prebuildCachePath(cache: string, url: string): string {
  const digest = createHash("sha512").update(url).digest("hex").slice(0, 6);
  return join(cache, "_prebuilds", `${digest}-${basename(url).replace(/[^a-zA-Z0-9.]+/g, "-")}`);
}

export async function seedNativePrebuild(
  cache = process.env.npm_config_cache ?? join(homedir(), ".npm"),
  download = releaseDownload,
): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("CI native relay prebuild requires Linux x64");
  const response = await download(nativePrebuild.url);
  if (!response.ok) throw new Error(`Native prebuild download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== nativePrebuild.sha256)
    throw new Error("Native prebuild archive checksum mismatch");
  await mkdir(join(cache, "_prebuilds"), { recursive: true });
  await writeFile(prebuildCachePath(cache, nativePrebuild.url), bytes);
}
