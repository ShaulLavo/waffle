import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertWasiLibcBuildInputs, wasiLibcBuildInputs } from "./package-inputs.js";

const packageRoot = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "waffle-tarball-"));
const archiveDirectory = join(scratch, "archive");
const extractDirectory = join(scratch, "extract");
const consumerDirectory = join(scratch, "consumer");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected package mapping");
  return value;
}

function verifyExportTargets(root: string, entry: Record<string, unknown>): void {
  for (const target of Object.values(entry)) {
    if (typeof target !== "string" || !target.startsWith("./"))
      throw new Error("invalid export target");
    if (!existsSync(join(root, target))) throw new Error(`archive is missing export ${target}`);
  }
}

async function run(): Promise<void> {
  await Promise.all([
    Bun.$`mkdir -p ${archiveDirectory}`.quiet(),
    Bun.$`mkdir -p ${extractDirectory}`.quiet(),
    Bun.$`mkdir -p ${consumerDirectory}`.quiet(),
  ]);
  execFileSync("bun", ["pm", "pack", "--destination", archiveDirectory], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  const archives = (await readdir(archiveDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1)
    throw new Error(`expected one package archive, found ${archives.length}`);
  const archive = join(archiveDirectory, archives[0]!);
  execFileSync("tar", ["-xzf", archive, "-C", extractDirectory], { stdio: "pipe" });
  const packedRoot = join(extractDirectory, "package");
  const required = [
    "package.json",
    "LICENSE",
    "LICENSES/Apache-2.0.txt",
    "index.ts",
    "dist/index.js",
    "link/relay.ts",
    "dist/link/relay.js",
    "browser/worker.ts",
    "browser/net/network.wasm",
    "dist/browser/net/network.wasm",
  ].concat(wasiLibcBuildInputs);
  for (const path of required) {
    if (!existsSync(join(packedRoot, path))) throw new Error(`archive is missing ${path}`);
  }
  if (!(await readFile(join(packedRoot, "LICENSE"), "utf8")).startsWith("MIT License"))
    throw new Error("archive has the wrong MIT license");
  if (
    !(await readFile(join(packedRoot, "LICENSES/Apache-2.0.txt"), "utf8")).includes(
      "Apache License",
    )
  )
    throw new Error("archive has the wrong upstream license notice");
  assertWasiLibcBuildInputs(packedRoot);
  const sourcePatch = await readFile(join(packageRoot, wasiLibcBuildInputs[1]));
  const packedPatch = await readFile(join(packedRoot, wasiLibcBuildInputs[1]));
  if (!sourcePatch.equals(packedPatch))
    throw new Error(`archive changed ${wasiLibcBuildInputs[1]} bytes`);
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "waffle-tarball-consumer",
      private: true,
      type: "module",
      dependencies: { waffle: `file:${archive}`, vite: "8.3.4" },
    }) + "\n",
  );
  execFileSync("bun", ["install", "--no-progress", "--ignore-scripts"], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  assertWasiLibcBuildInputs(join(consumerDirectory, "node_modules/waffle"));
  const metadata = record(JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8")));
  const exports = record(metadata.exports);
  const nodeSpecifiers: string[] = [];
  for (const [key, target] of Object.entries(exports)) {
    const entry = record(target);
    verifyExportTargets(packedRoot, entry);
    if (typeof entry.node === "string")
      nodeSpecifiers.push(key === "." ? "waffle" : `waffle${key.slice(1)}`);
  }
  const nodeScript = `
    for (const specifier of ${JSON.stringify(nodeSpecifiers)}) await import(specifier);
    const { loadNetworkModule } = await import("waffle/network");
    const network = (await loadNetworkModule()).create();
    try { if (network.call("net_listen", 40, 23456) !== 23456) throw new Error("packed network failed"); }
    finally { network.dispose(); }
  `;
  execFileSync("node", ["--input-type=module", "--eval", nodeScript], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  execFileSync("bun", ["-e", 'await import("waffle"); await import("waffle/browser/worker");'], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  await mkdir(join(consumerDirectory, "src"));
  await writeFile(
    join(consumerDirectory, "index.html"),
    '<script type="module" src="/src/main.ts"></script>\n',
  );
  await writeFile(
    join(consumerDirectory, "src/main.ts"),
    'import { bootstrap } from "waffle/browser/worker";\nimport searchUrl from "waffle/search/search-worker?worker&url";\nimport shardUrl from "waffle/search/shard-worker?worker&url";\nexport { bootstrap, searchUrl, shardUrl };\n',
  );
  execFileSync("bun", ["run", "vite", "build", "--outDir", join(scratch, "vite-dist")], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
}

try {
  await run();
  console.log("waffle tarball smoke: pass");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
