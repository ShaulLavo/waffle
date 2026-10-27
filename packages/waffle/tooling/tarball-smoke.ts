import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(process.env.TMPDIR ?? "/work/tmp", "waffle-tarball-"));
const archiveDirectory = join(scratch, "archive");
const extractDirectory = join(scratch, "extract");
const consumerDirectory = join(scratch, "consumer");

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
    "index.ts",
    "dist/index.js",
    "browser/worker.ts",
    "browser/net/network.wasm",
    "dist/browser/net/network.wasm",
  ];
  for (const path of required) {
    if (!existsSync(join(packedRoot, path))) throw new Error(`archive is missing ${path}`);
  }
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "waffle-tarball-consumer",
      private: true,
      type: "module",
      dependencies: { waffle: `file:${packedRoot}`, vite: "8.3.4" },
    }) + "\n",
  );
  execFileSync("bun", ["install", "--no-progress", "--ignore-scripts"], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  const metadata = JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, { node?: string }>;
  };
  const nodeSpecifiers = Object.entries(metadata.exports)
    .filter(([, target]) => target.node !== undefined)
    .map(([key]) => (key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`));
  const nodeScript = `for (const specifier of ${JSON.stringify(nodeSpecifiers)}) await import(specifier);`;
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
    'import { bootstrap } from "waffle/browser/worker";\nexport { bootstrap };\n',
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
