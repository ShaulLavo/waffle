import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  await frameworkConsumer(consumerDirectory, "packed");
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
    if (path.startsWith("node:") || /playwright|network-relay|native-peer|browser-runner-lifecycle|storage-browser|host-storage-control|\\/(core|fs|proc|browser|network)\\//.test(path)) throw new Error("installed page graph leak " + path);
    if (!resolve(path).startsWith(process.cwd() + "/")) throw new Error("checkout dependency leak " + path);
  }
`;
const adapterTypes = `
import { runPageSuite, nativeMain, ownedDatabase, type SuiteAdapter, type NativeOptions, type PreparationContext, type Driver, type HostCase, type AssetHoldCallback, type HeldAssetRequest, type HostPeer, type SuiteCase, type HostVerdict } from "waffle/testing/page-runner";
import { isHostedPage, startPage, cleanupStorage, type PageSuite, type HostPageRun } from "waffle/testing/page-runner/page";
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
const hostCase: SuiteCase<{ databaseName: string }> = {
  id: "host", label: "host case", request: run => ({ databaseName: run }),
  drive: async (host: HostCase) => {
    host.signal.throwIfAborted();
    const remaining = host.remainingMs();
    const callback: AssetHoldCallback = async (request: HeldAssetRequest) => {
      await request.continue();
      // @ts-expect-error continuation cannot change original response
      request.continue({ body: "replacement" });
      // @ts-expect-error callback has no HTTP authority
      void request.headers;
    };
    host.holdAsset("/programs/shell-engine.wasm", callback);
    // @ts-expect-error response replacement is not supported
    host.holdAsset("/programs/test-guest.wasm", async () => new Response("replacement"));
    await host.script("window.fixture = 1;");
    await host.task("await Promise.resolve();");
    const peer = await host.openPeer();
    await peer.script("return null");
    await peer.task("await Promise.resolve()");
    const successor = await peer.reload();
    await successor.close();
    // @ts-expect-error raw driver authority is private
    host.driver;
    // @ts-expect-error peer identity is host-owned
    peer.generation = 4;
    // @ts-expect-error no raw handle selection
    peer.selectWindow("caller");
    // @ts-expect-error caller IDs cannot construct a peer capability
    const forged: HostPeer = { peer: "caller", generation: 0 };
    void forged;
    const database: Promise<string> = host.allocateDatabase("consumer");
    await database;
    await host.sleep(1);
    return { remaining };
  },
};
const hostAdapter: SuiteAdapter<{ databaseName: string }> = {
  ...adapter, inventory: () => [hostCase],
  budgets: () => ({ hello: 20_000, heartbeat: 10_000, case: 60_000, operation: 15_000, teardown: 60_000, caseDocument: 150_000, group: 90_000, run: 2_160_000 }),
};
const hostRun: HostPageRun<{ databaseName: string }> = {
  kind: "host", peer: async (request, allocate) => { await allocate({ kind: "indexeddb", name: request.databaseName }); }, teardown: async (request, verdict: HostVerdict) => ({ name: request.databaseName, status: verdict.status }),
};
const hostSuite: PageSuite<{ databaseName: string }> = {
  list: async () => ({ ids: [hostCase.id] }), run: hostRun, finish: async ledger => ledger.slice(),
};
export { hostAdapter, hostSuite };
export function customDriver(driver: Driver): Driver {
  return {
    start: signal => driver.start(signal),
    navigate: (url, signal) => driver.navigate(url, signal),
    createWindow: signal => driver.createWindow(signal),
    selectWindow: (handle, signal) => driver.selectWindow(handle, signal),
    reloadWindow: signal => driver.reloadWindow(signal),
    closeWindow: signal => driver.closeWindow(signal),
    handle: signal => driver.handle(signal),
    handles: signal => driver.handles(signal),
    url: signal => driver.url(signal),
    script: (source, signal) => driver.script(source, signal),
    stop: () => driver.stop(),
    get uncertain() { return driver.uncertain; },
  };
}

const options: NativeOptions = { startedAt: performance.now(), port: "ephemeral", signal: new AbortController().signal, scratchRoot: "/configured/scratch" };
const declared: SuiteAdapter<null> = {
  ...adapter, inventory: () => [{ id: "consumer", label: "worker", request: () => null }],
  serviceWorker: { caseId: "consumer", script: "/worker.js" },
  fixture: { caseId: "consumer", create: () => ({
    start: async ({ origin, signal, scratch, run }) => [{ path: "/config", get: async ({ signal: requestSignal }) => { signal.throwIfAborted(); requestSignal.throwIfAborted(); return { origin, scratch, run }; } }],
    close: async () => {},
  }) },
};
export { declared };
const durable: import("waffle/testing/page-runner").StorageEntry = { kind: "service-worker", name: "http://localhost/scope/", clientURL: "http://localhost/scope/client", scriptURL: "http://localhost/sw.js" };
void durable;
const suite: PageSuite<{ databaseName: string }> = {
  list: async () => ({ ids: ["consumer"] }),
  run: async (request, allocate, context) => {
    await allocate({ kind: "indexeddb", name: request.databaseName });
    if (context.serviceWorker) {
      const registration = await context.serviceWorker.register();
      context.serviceWorker.controls(registration, navigator.serviceWorker.controller);
      await context.serviceWorker.unregister(registration);
    }
    await context.fetchFixture("/config");
    return { ok: true };
  },
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
    for (const path of ["waffle/testing/page-runner", "waffle/testing/page-runner/page", "waffle/testing/page-runner/playwright"]) {
      try { await import(path); throw new Error("Node accepted Bun-only entry " + path); }
      catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }
    }
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
async function frameworkConsumer(directory: string, phase: string): Promise<void> {
  consumerCommand(directory, "node", [
    "--input-type=module",
    "--eval",
    `
    import { createFrameworkHost } from "waffle/testing/page-runner/framework";
    import { getFrameworkObservation } from "waffle/testing/page-runner/framework-page";
    if (typeof createFrameworkHost !== "function" || getFrameworkObservation() !== undefined) throw new Error("bad Node framework entry");
    const entry = import.meta.resolve("waffle/testing/page-runner/framework");
    if (!entry.endsWith("/node_modules/waffle/dist/tests/page-runner/framework.js")) throw new Error("Node did not resolve prepared installed JavaScript");
  `,
  ]);
  await writeFile(
    join(directory, "framework-page.ts"),
    'export { getFrameworkObservation } from "waffle/testing/page-runner/framework-page";',
  );
  consumerCommand(directory, "bun", [
    "--eval",
    `
    const build = await Bun.build({ entrypoints: ["./framework-page.ts"], target: "browser", metafile: true });
    if (!build.success || !build.metafile) throw new Error("framework browser graph failed");
    for (const path of Object.keys(build.metafile.inputs)) {
      if (/node:|playwright|safari-driver|framework-host|\\/(core|fs|proc|browser|network)\\//.test(path)) throw new Error("framework browser graph leak " + path);
      if (!require("node:path").resolve(path).startsWith(process.cwd() + "/")) throw new Error("framework checkout dependency leak");
    }
  `,
  ]);
  const manifestPath = join(directory, "package.json");
  const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
  manifest.devDependencies = {
    ...record(manifest.devDependencies),
    "@vitest/browser": "5.0.2",
    "@vitest/browser-webdriverio": "5.0.0",
    vitest: "5.0.2",
    webdriverio: "9.29.1",
    undici: "6.29.1",
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  consumerCommand(directory, "bun", [
    "install",
    "--ignore-scripts",
    "--linker=hoisted",
    "--backend=copyfile",
  ]);
  await writeFile(
    join(directory, "framework-installed.ts"),
    await readFile(join(packageRoot, "tests/page-runner/framework-controls/installed.ts")),
  );
  await writeFile(
    join(directory, "framework-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: true,
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        resolveJsonModule: true,
        types: ["node"],
        lib: ["ES2024", "DOM", "DOM.Iterable"],
      },
      include: ["framework-installed.ts", "framework-page.ts"],
    }),
  );
  consumerCommand(directory, "bun", [
    "node_modules/typescript/bin/tsc",
    "-p",
    "framework-tsconfig.json",
  ]);
  for (const mode of ["unowned", "expired", "revoked", "malformed", "wrong-capabilities"]) {
    execFileSync("node", ["--experimental-strip-types", "framework-installed.ts"], {
      cwd: directory,
      stdio: "pipe",
      timeout: 55000,
      env: { ...process.env, NODE_PATH: "", W3_MODE: mode },
    });
    console.log(`waffle installed framework ${phase} ${mode}: checked finite abort`);
  }
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
  if (!existsSync(join(installed, "dist/tests/page-runner/framework.js")))
    throw new Error("source preparation did not emit the framework host");
  const prepared = join(scratch, "source-prepared-node");
  await rename(join(installed, "dist"), prepared);
  // Remove prepared output to prove all three testing entries use their source targets.
  await pageRunnerConsumer(consumer);
  // Installing explicit tooling can recopy prepared source files. W1 already ran without them.
  await rm(join(installed, "dist"), { recursive: true, force: true });
  await rename(prepared, join(installed, "dist"));
  await frameworkConsumer(consumer, "source");
}

try {
  await run();
  console.log("waffle tarball smoke: pass");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
