import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseDownload, saveReleaseResponse } from "./ci-release-download.ts";

const nodeManifest =
  "https://raw.githubusercontent.com/actions/node-versions/main/versions-manifest.json";
type NodeRelease = { version: string; url: string };

export function selectNodeRelease(value: unknown, selector: string): NodeRelease {
  if (!/^\d+(?:\.\d+\.\d+)?$/.test(selector))
    throw new Error(`Unsupported Node selector: ${selector}`);
  if (!Array.isArray(value)) throw new Error("Invalid Node release manifest");
  const releases: NodeRelease[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      entry.stable !== true ||
      typeof entry.version !== "string" ||
      !Array.isArray(entry.files)
    )
      continue;
    if (entry.version !== selector && entry.version.split(".")[0] !== selector) continue;
    const file = entry.files.find(
      (file: unknown) =>
        file &&
        typeof file === "object" &&
        "platform" in file &&
        file.platform === "linux" &&
        "arch" in file &&
        file.arch === "x64",
    );
    if (
      !file ||
      typeof file.download_url !== "string" ||
      !/^https:\/\/github\.com\/actions\/node-versions\/releases\/download\/[^/]+\/node-[^/]+-linux-x64\.tar\.gz$/.test(
        file.download_url,
      )
    )
      throw new Error("Invalid Node release asset");
    releases.push({ version: entry.version, url: file.download_url });
  }
  releases.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  if (!releases[0]) throw new Error(`Missing Node release: ${selector}`);
  return releases[0];
}

async function installArchive(
  url: string,
  destination: string,
  kind: "node" | "bun",
  download: typeof releaseDownload,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(join(destination, ".download-"));
  try {
    const archive = join(stage, "archive");
    const response = await download(url);
    if (!response.ok) throw new Error(`${kind} download failed: HTTP ${response.status}`);
    await saveReleaseResponse(archive, response);
    if (kind === "node")
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination]);
    else execFileSync("unzip", ["-qo", archive, "-d", destination]);
    return kind === "node" ? join(destination, "bin") : join(destination, "bun-linux-x64");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function setupTools(
  root: string,
  bunVersion: string,
  nodeVersion?: string,
  download = releaseDownload,
): Promise<string[]> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("CI bootstrap requires Linux x64");
  if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) throw new Error("Bun version must be exact");
  const paths: string[] = [];
  if (nodeVersion) {
    const response = await download(nodeManifest);
    if (!response.ok) throw new Error(`Node manifest failed: HTTP ${response.status}`);
    const pin = selectNodeRelease(await response.json(), nodeVersion);
    const bin = await installArchive(pin.url, join(root, `node-${pin.version}`), "node", download);
    if (
      execFileSync(join(bin, "node"), ["--version"], { encoding: "utf8" }).trim() !==
      `v${pin.version}`
    )
      throw new Error("Node version mismatch");
    paths.push(bin);
  }
  const bin = await installArchive(
    `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-x64.zip`,
    join(root, `bun-${bunVersion}`),
    "bun",
    download,
  );
  if (execFileSync(join(bin, "bun"), ["--version"], { encoding: "utf8" }).trim() !== bunVersion)
    throw new Error("Bun version mismatch");
  await rm(join(bin, "bunx"), { force: true });
  await symlink("bun", join(bin, "bunx"));
  paths.push(bin);
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.RUNNER_TEMP;
  const output = process.env.GITHUB_PATH;
  if (!root || !output) throw new Error("Set RUNNER_TEMP and GITHUB_PATH");
  const paths = await setupTools(
    join(root, "ci-tools"),
    process.env.CI_BUN_VERSION ?? "",
    process.env.CI_NODE_VERSION || undefined,
  );
  await appendFile(output, paths.join("\n") + "\n");
}
