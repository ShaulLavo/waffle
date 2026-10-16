// Artifact-free bundle gate. From the repository root: bun scripts/runtime-size.ts [--json]
// Standalone layer closures overlap: they are actionable import costs, not additive attribution.
import { posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { browserBuildConfig } from "./browser-build";
import { previewWebsocketScript } from "../web/preview-build";

type OutputGraph = Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;

/** Follow only statically imported JS, preserving asset URLs (not source-map inputs). */
export function initialJavaScript(outputs: OutputGraph, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  function visit(path: string): void {
    if (seen.has(path)) return;
    const output = outputs[path];
    if (!output) throw new Error(`Missing initial JavaScript output: ${path}`);
    seen.add(path);
    for (const imported of output.imports) {
      if (imported.kind === "dynamic-import") continue;
      if (imported.external) throw new Error(`Unmeasured external initial import: ${imported.path}`);
      if (!imported.path.endsWith(".js")) continue;
      const dependency = imported.path in outputs ? imported.path : posix.normalize(posix.join(posix.dirname(path), imported.path));
      visit(dependency);
    }
  }
  for (const root of roots) visit(root);
  return Array.from(seen).sort();
}

export function checkCoreBudget(gzipBytes: number): void {
  const budget = 6 * 1024;
  if (gzipBytes > budget) throw new Error(`core exceeds ${budget} B gzip budget by ${gzipBytes - budget} B; inspect runtime/core imports and the layer report`);
}

const root = resolve(import.meta.dir, "..");
const bytes = async (output: Blob) => {
  const buffer = Buffer.from(await output.arrayBuffer());
  return { minified: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length };
};
const totals = (rows: readonly { minified: number; gzip: number }[]) => rows.reduce((sum, row) => ({ minified: sum.minified + row.minified, gzip: sum.gzip + row.gzip }), { minified: 0, gzip: 0 });

async function build(config: Parameters<typeof Bun.build>[0]) {
  // Bun's JS API writes when outdir is set; omitting it is the artifact-free mode.
  const { outdir: _outdir, ...inMemory } = config;
  const result = await Bun.build({ ...inMemory, metafile: true });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result;
}

async function layer(name: string, entries: readonly string[], guideKiB: number) {
  const outdir = resolve(root, ".runtime-size", name);
  const result = await build({ entrypoints: entries.map((path) => resolve(root, path)), outdir, target: "browser", format: "esm", minify: true, splitting: true });
  const files = await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map(async (output) => ({ path: posix.normalize(output.path), ...await bytes(output) })));
  const sizes = totals(files);
  return { name, entries, ...sizes, guideGzip: guideKiB * 1024, files };
}

async function application(name: "web" | "sandbox", splitting: boolean, serviceWorker: { minified: number; gzip: number }) {
  const outdir = resolve(root, ".runtime-size", `${name}-${splitting ? "split" : "unsplit"}`);
  const result = await build(browserBuildConfig([resolve(root, name, "src/main.ts"), resolve(root, "web/src/worker.ts")], outdir, { splitting }));
  const outputs = result.metafile!.outputs;
  const keyFor = (name: string) => {
    const key = Object.keys(outputs).find((path) => posix.normalize(path) === name);
    if (!key) throw new Error(`Missing ${name} in ${name} bundle metadata`);
    return key;
  };
  const fileFor = (key: string) => {
    const file = result.outputs.find((output) => resolve(output.path) === resolve(key));
    if (!file) throw new Error(`Missing built artifact ${key}`);
    return file;
  };
  const rowFor = async (key: string) => ({ path: posix.normalize(key), ...await bytes(fileFor(key)) });
  const main = initialJavaScript(outputs, [keyFor("main.js")]);
  const worker = initialJavaScript(outputs, [keyFor("worker.js")]);
  const initialKeys = Array.from(new Set(main.concat(worker))).sort();
  const logicalFiles = (await Promise.all(initialKeys.map(rowFor))).concat([{ path: "sw.js", ...serviceWorker }]);
  const logicalEntries = await Promise.all(["main.js", "worker.js"].map(async (entry) => {
    const files = await Promise.all(initialJavaScript(outputs, [keyFor(entry)]).map(rowFor));
    return { entry, ...totals(files), files };
  }));
  // Root page and scoped worker resolve a shared chunk to different URLs, so both count.
  const initialDownloads = (await Promise.all(main.map(rowFor))).concat(
    await Promise.all(worker.map(async (key) => { const row = await rowFor(key); return { ...row, path: `__bunwasm/${row.path}` }; })),
    [{ path: "sw.js", ...serviceWorker }],
  );
  const inputs = Array.from(new Set(initialKeys.flatMap((key) => Object.keys(outputs[key]!.inputs)))).sort();
  const procInputs = inputs.filter((path) => /(?:\/|^)subprocess(?:[-.]|\/)/.test(path));
  return {
    splitting, logicalEntries: logicalEntries.concat([{ entry: "sw.js", ...serviceWorker, files: [{ path: "sw.js", ...serviceWorker }] }]),
    logicalJavaScript: { ...totals(logicalFiles), files: logicalFiles },
    bunLightInitialJavaScript: { ...totals(initialDownloads), files: initialDownloads },
    // Two registrations use the same classic script today. Cold browsers can fetch it twice.
    serviceWorkerRegistrations: [{ script: "sw.js", scope: "__bunwasm/" }, { script: "sw.js", scope: "__preview/" }],
    coldJavaScriptWithBothRegistrations: totals(initialDownloads.concat([{ path: "sw.js (second registration)", ...serviceWorker }])),
    otherBunLightDownloads: ["index.html", "main.css", "bun-browser.wasm.gz"].concat(name === "sandbox" ? ["template.json"] : []),
    excludedDownloads: ["bun.wasm.gz", "bun-jsc.wasm.gz", "*.map"],
    proc: { eager: procInputs.length > 0, inputs: procInputs, note: "Step 2 preserves the current eager process graph; first-spawn loading belongs to step 4a." },
  };
}

export async function runtimeSizeReport() {
  const previewSocketScript = await previewWebsocketScript();
  const layers = await Promise.all([
    layer("core", ["runtime/core/index.ts"], 6),
    layer("fs", ["web/src/fs.ts"], 6),
    layer("net", ["web/src/net/host.ts", "web/src/net/helper.ts", "web/src/preview.ts"], 14),
    layer("proc", ["web/src/subprocess.js", "web/src/subprocess-broker.ts", "web/src/subprocess-fs.ts"], 8),
  ]);
  // This separately linked preview client uses a source-wrapper plugin; measure its real build.
  const net = layers.find((layer) => layer.name === "net")!;
  net.files.push({ path: "preview-websocket-client.js", ...await bytes(new Blob([previewSocketScript])) });
  Object.assign(net, totals(net.files));
  const sw = await build({
    entrypoints: [resolve(root, "web/src/sw.ts")], outdir: resolve(root, ".runtime-size/sw"),
    target: "browser", format: "iife", minify: true,
    define: { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(previewSocketScript) },
  });
  const serviceWorker = await bytes(sw.outputs[0]!);
  const applications: Record<string, unknown> = {};
  for (const name of ["web", "sandbox"] as const) {
    applications[name] = { beforeUnsplit: await application(name, false, serviceWorker), afterSplit: await application(name, true, serviceWorker) };
  }
  return { method: "Same-source before/after splitting. gzip level 9; maps excluded. Layer closures export all public symbols, include transitive dependencies and overlap (not additive). Initial graph lists statically reachable request URLs with a scoped worker, counting root/scoped chunk copies separately regardless of SW proxy/cache reuse. The two-registration cold estimate adds a second classic SW fetch; neither estimate is a network capture. No WASM or app dist is read/built. Budgets for fs/net/proc are guides; only core is gated.", layers, applications };
}

if (import.meta.main) {
  const report = await runtimeSizeReport();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.method);
    console.table(report.layers.map(({ name, minified, gzip, guideGzip }) => ({ layer: name, minified, gzip, guideGzip })));
    for (const [name, scenarios] of Object.entries(report.applications)) {
      console.log(`\n${name}:`);
      for (const [scenario, details] of Object.entries(scenarios as Record<string, Awaited<ReturnType<typeof application>>>)) {
        console.log(`${scenario}: logical JS ${details.logicalJavaScript.minified} B / ${details.logicalJavaScript.gzip} B gzip; Bun light initial JS ${details.bunLightInitialJavaScript.minified} B / ${details.bunLightInitialJavaScript.gzip} B gzip`);
        console.table(details.logicalEntries.map(({ entry, minified, gzip }) => ({ entry, minified, gzip })));
        console.log("Bun light initial JS URLs:", details.bunLightInitialJavaScript.files.map((file) => file.path).join(", "));
        console.log("Other Bun light downloads:", details.otherBunLightDownloads.join(", "));
        console.log(`Proc eager: ${details.proc.eager}; ${details.proc.note}`);
      }
    }
  }
  checkCoreBudget(report.layers.find((layer) => layer.name === "core")!.gzip);
}
