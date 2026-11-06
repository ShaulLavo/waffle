import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    "group/state.ts",
    "dist/group/state.js",
    "search/matcher.ts",
    "dist/search/matcher.js",
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
  execFileSync(
    "bun",
    ["install", "--no-progress", "--ignore-scripts", "--linker=hoisted", "--backend=copyfile"],
    {
      cwd: consumerDirectory,
      stdio: "pipe",
    },
  );
  assertWasiLibcBuildInputs(join(consumerDirectory, "node_modules/waffle"));
  await pageRunnerConsumer(consumerDirectory);
  await sourceInstallParity(packedRoot);
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

function consumerCommand(directory: string, command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: directory,
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_PATH: "",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      WAFFLE_NETWORK_PREBUILT: "1",
    },
  });
}
const pageRunnerScript = `
  import { nativeMain, ownedDatabase } from "waffle/testing/page-runner";
  import { isHostedPage } from "waffle/testing/page-runner/page";
  import { readdir } from "node:fs/promises";
  import { join, resolve } from "node:path";
  if (isHostedPage()) throw new Error("page import accessed a hosted window");
  for (const [specifier, suffix] of [
    ["waffle/testing/page-runner", "/tests/page-runner/consumer.ts"],
    ["waffle/testing/page-runner/page", "/tests/page-runner/consumer-page.ts"],
  ]) {
    const path = import.meta.resolve(specifier);
    if (!path.endsWith(suffix) || !path.includes("/node_modules/waffle/")) throw new Error("wrong installed source entry " + path);
  }
  let playwright;
  try { playwright = import.meta.resolve("playwright"); } catch {}
  if (playwright) throw new Error("Playwright leaked into no-Playwright consumer: " + playwright);
  const resultPath = resolve("native-result.json");
  const adapter = {
    suite: "installed-consumer",
    inventory() { throw new Error("precondition allocated inventory"); },
    assets() { throw new Error("precondition allocated assets"); },
    budgets() { throw new Error("precondition allocated budgets"); },
    policy: { allocation: ownedDatabase("installed"), listIds() { return []; }, requireResult: true, check() {} },
  };
  if (await nativeMain(adapter, ["--result", resultPath]) !== 3) throw new Error("wrong native precondition");
  const result = await Bun.file(resultPath).json();
  if (result.suite !== adapter.suite || result.exit !== 3) throw new Error("wrong precondition result");
  if ((await readdir(".")).some(name => name.startsWith("w-pr-"))) throw new Error("native allocated scratch");
  const built = await Bun.build({ entrypoints: [resolve("page.ts")], target: "browser", metafile: true });
  if (!built.success || !built.metafile) throw new Error("installed page build failed");
  for (const path of Object.keys(built.metafile.inputs)) {
    if (path.startsWith("node:") || /playwright|browser-runner-lifecycle|storage-browser|\\/(core|fs|proc|browser|network)\\//.test(path)) throw new Error("installed page graph leak " + path);
    if (!resolve(path).startsWith(process.cwd() + "/")) throw new Error("checkout dependency leak " + path);
  }
`;
const adapterTypes = `
import { runPageSuite, nativeMain, ownedDatabase, type SuiteAdapter, type NativeOptions, type PreparationContext, type Driver } from "waffle/testing/page-runner";
import { isHostedPage, startPage, cleanupStorage, type PageSuite } from "waffle/testing/page-runner/page";
const adapter: SuiteAdapter<{ databaseName: string }> = {
  suite: "consumer-types",
  inventory: () => [{ id: "consumer", label: "default", request: run => ({ databaseName: \`consumer-\${run}\` }) }],
  policy: { listIds: () => ["consumer"], requireResult: true, allocation: ownedDatabase("consumer"), check() {} },
  assets: async ({ scratch, signal }: PreparationContext) => {
    signal.throwIfAborted();
    return { "/current/page.js": Bun.file(scratch + "/current/page.js") };
  },
  page: { path: "/current/", script: "/current/page.js" }, resultWaitMs: 90_000,
  budgets: () => ({ hello: 20_000, heartbeat: 10_000, case: 120_000, group: 120_000, run: 120_000 }),
};
const options: NativeOptions = { startedAt: performance.now(), port: 4186 };
const suite: PageSuite<{ databaseName: string }> = {
  list: async () => ({ ids: ["consumer"] }),
  run: async (request, allocate) => { await allocate({ kind: "indexeddb", name: request.databaseName }); return { ok: true }; },
  finish: ledger => cleanupStorage(ledger),
};
if (isHostedPage()) startPage(suite);
export async function run(factory: (scratch: string) => Driver) {
  await nativeMain(adapter, ["--result", "/absolute/result.json"], options);
  return runPageSuite(adapter, factory, { resultPath: "/absolute/result.json", ...options });
}
`;
async function pageRunnerConsumer(directory: string): Promise<void> {
  await writeFile(
    join(directory, "page.ts"),
    'export { isHostedPage, startPage, cleanupStorage } from "waffle/testing/page-runner/page";',
  );
  await writeFile(join(directory, "page-runner.ts"), pageRunnerScript);
  consumerCommand(directory, "bun", ["page-runner.ts"]);
  consumerCommand(directory, "node", [
    "--input-type=module",
    "--eval",
    `
    try { await import("waffle/testing/page-runner"); throw new Error("Node accepted Bun-only host"); }
    catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }
  `,
  ]);
  const manifestPath = join(directory, "package.json");
  const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
  manifest.devDependencies = { playwright: "1.64.1", typescript: "7.0.2", "@types/bun": "1.4.4" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  consumerCommand(directory, "bun", [
    "install",
    "--no-progress",
    "--ignore-scripts",
    "--linker=hoisted",
    "--backend=copyfile",
  ]);
  consumerCommand(directory, "bun", [
    "-e",
    `
    import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
    const path = import.meta.resolve("playwright");
    if (!path.startsWith("file://" + process.cwd() + "/node_modules/")) throw new Error("Playwright ancestor leak " + path);
    if (typeof PlaywrightDriver !== "function") throw new Error("missing explicit driver");
  `,
  ]);
  await writeFile(join(directory, "adapter.ts"), adapterTypes);
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: true,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
        types: ["bun"],
        lib: ["ES2023", "DOM", "DOM.Iterable"],
      },
      include: ["adapter.ts", "page.ts"],
    }),
  );
  consumerCommand(directory, "bun", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
}
async function sourceInstallParity(packedRoot: string): Promise<void> {
  const source = join(scratch, "source-package"),
    consumer = join(scratch, "source-consumer");
  await cp(packedRoot, source, {
    recursive: true,
    filter: (path) => path !== join(packedRoot, "dist"),
  });
  consumerCommand(source, "bun", ["prepare.ts"]);
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "waffle-source-consumer",
      private: true,
      type: "module",
      dependencies: { waffle: `file:${source}` },
      trustedDependencies: ["waffle"],
    }),
  );
  consumerCommand(consumer, "bun", [
    "install",
    "--production",
    "--no-progress",
    "--linker=hoisted",
    "--backend=copyfile",
  ]);
  const installed = join(consumer, "node_modules/waffle");
  if (!existsSync(join(installed, "dist/index.js")))
    throw new Error("source preparation did not emit Node entries");
  if (existsSync(join(installed, "dist/tests")))
    throw new Error("testing entries depend on generated tests");
  // Remove prepared output to prove all three testing entries use their source targets.
  await rm(join(installed, "dist"), { recursive: true, force: true });
  await pageRunnerConsumer(consumer);
}

try {
  await run();
  console.log("waffle tarball smoke: pass");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
