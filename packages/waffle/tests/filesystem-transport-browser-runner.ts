import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { runOwned } from "../scripts/owned-command.js";
import { runBrowserSuite } from "../scripts/browser-command.js";

const engine = process.argv[2] ?? "firefox";
const oldAt = process.argv.indexOf("--old-source");
const old = oldAt < 0 ? undefined : process.argv[oldAt + 1];
const rounds = process.env.FS_TRANSPORT_ROUNDS ?? "60";
const port = Number(process.env.FS_TRANSPORT_PORT ?? 4301);
const packageRoot = resolve(import.meta.dir, "..");
const repository = resolve(packageRoot, "../..");
const scratchRoot = process.env.FS_TRANSPORT_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp";
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "wfs-port-"));
const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
let server: ReturnType<typeof Bun.serve> | undefined;
let source = packageRoot;
try {
  console.log(JSON.stringify({ resources: "filesystem-transport", scratch, port, engine, oldSource: old ?? null }));
  if (old) {
    await runOwned(["git", "archive", "-o", join(scratch, "source.tar"), old, "packages/waffle"], { cwd: repository, env: process.env, signal: stopped.signal });
    await runOwned(["tar", "-xf", join(scratch, "source.tar"), "-C", scratch], { cwd: repository, env: process.env, signal: stopped.signal });
    source = join(scratch, "packages/waffle");
  }
  const scripts = new Map<string, Blob>();
  const hashes: Record<string, string> = {};
  const entries = [
    ["filesystem-transport-browser.ts", "/page.js"],
    ["fixtures/filesystem-port-service.ts", "/fs.js"],
    ["fixtures/filesystem-port-worker.ts", "/child.js"],
  ];
  for (const [entry, url] of entries) {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, entry!)], target: "browser", format: "esm",
      define: { LEGACY_SOURCE: old ? "true" : "false" },
      plugins: [{ name: "frozen-filesystem-source", setup(builder) {
        builder.onResolve({ filter: /fs\/index\.js$/ }, args => {
          if (!args.importer.startsWith(import.meta.dir)) return;
          return { path: join(source, "fs/index.ts") };
        });
      } }],
    });
    if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs, `transport build ${entry}`);
    scripts.set(url!, build.outputs[0]);
    hashes[url!] = createHash("sha256").update(new Uint8Array(await build.outputs[0].arrayBuffer())).digest("hex");
  }
  const driver = await Bun.build({ entrypoints: [join(import.meta.dir, "filesystem-transport-browser-driver.ts")], target: "node", format: "esm", packages: "external" });
  if (!driver.success || !driver.outputs[0]) throw new AggregateError(driver.logs);
  await writeFile(join(scratch, "drive.mjs"), await driver.outputs[0].text());
  await symlink(join(repository, "node_modules"), join(scratch, "node_modules"), "dir");
  const headers = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><script type="module" src="/page.js"></script>', { headers: { ...headers, "content-type": "text/html" } });
    const script = scripts.get(path);
    return new Response(script ?? "missing", { status: script ? 200 : 404, headers: { ...headers, "content-type": "text/javascript" } });
  } });
  console.log(JSON.stringify({ source, hashes }));
  await runBrowserSuite(["node", join(scratch, "drive.mjs"), engine, String(port), rounds, "2"], { cwd: repository, env: process.env, signal: stopped.signal, timeoutMs: 180000 });
} finally {
  server?.stop(true);
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  await rm(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: "filesystem-transport", scratch, removed: true }));
}
