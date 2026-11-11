import { createHash } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function releaseCacheInventory(
  directory: string,
): Promise<{ hash: string; count: number }> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const names = entries
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => entry.name);
  names.sort();
  return { hash: createHash("sha256").update(names.join("\n")).digest("hex"), count: names.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.CI_RELEASE_CACHE;
  if (!directory) throw new Error("Set CI_RELEASE_CACHE");
  const inventory = await releaseCacheInventory(directory);
  if (process.argv[2] === "restore") {
    if (!process.env.GITHUB_ENV) throw new Error("Set GITHUB_ENV");
    await appendFile(process.env.GITHUB_ENV, `CI_RELEASE_CACHE_INITIAL=${inventory.hash}\n`);
  } else {
    if (!process.env.GITHUB_OUTPUT || !process.env.CI_RELEASE_CACHE_INITIAL)
      throw new Error("Restore the release cache before saving");
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `changed=${inventory.count > 0 && inventory.hash !== process.env.CI_RELEASE_CACHE_INITIAL}\ninventory=${inventory.hash}\n`,
    );
  }
  console.error(`Release cache inventory: ${inventory.count} complete assets, ${inventory.hash}`);
}
