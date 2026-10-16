import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrowserEntries, buildClassicWorker } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("split main/worker graph has all static and dynamic chunks in the worker scope", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.split-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "shared.ts"), "export const shared = (value: string) => value.toUpperCase();");
  await Bun.write(join(dir, "lazy.ts"), "export const lazy = 'dynamic chunk';");
  await Bun.write(join(dir, "main.ts"), "import { shared } from './shared'; console.log(shared('page'));");
  await Bun.write(join(dir, "worker.ts"), "import { shared } from './shared'; postMessage([shared('worker'), (await import('./lazy')).lazy]);");
  const out = join(dir, "dist");
  const result = await buildBrowserEntries([join(dir, "main.ts"), join(dir, "worker.ts")], out);
  const chunks = result.outputs.filter((output) => output.kind === "chunk");
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  const outputs = result.metafile!.outputs;
  const workerKey = Object.keys(outputs).find((path) => path.endsWith("/worker.js"))!;
  const initial = initialJavaScript(outputs, [workerKey]);
  expect(initial).toHaveLength(2); // bootstrap plus shared chunk, not the dynamic chunk
  expect(initial.some((path) => path.endsWith("/worker.js"))).toBe(true);
  expect(await Bun.file(join(out, "__bunwasm/worker.js")).text()).toBe(await Bun.file(join(out, "worker.js")).text());
  for (const chunk of chunks) {
    const path = chunk.path.slice(out.length + 1);
    expect(path).toStartWith("chunks/");
    expect(await Bun.file(join(out, "__bunwasm", path)).text()).toBe(await chunk.text());
  }
});

async function sandboxOnlyInstall() {
  // Outside this checkout: none of the installed web dependencies can mask a missing resolver.
  const scratch = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const dir = await mkdtemp(join(scratch, "bun-wasm-resolver-"));
  owned.push(dir);
  const main = join(dir, "sandbox/src/main.ts");
  const worker = join(dir, "web/src/worker.ts");
  const dependency = join(dir, "sandbox/node_modules/@bun-wasm/runtime");
  await Bun.write(join(dependency, "package.json"), JSON.stringify({
    name: "@bun-wasm/runtime", type: "module",
    exports: { "./core": "./dist/public-core.ts", "./core/memory-views": "./dist/public-views.ts" },
  }));
  await Bun.write(join(dependency, "dist/public-core.ts"), "export const core = 'core from sandbox install';");
  await Bun.write(join(dependency, "dist/public-views.ts"), "export const views = 'views from sandbox install';");
  await Bun.write(join(dependency, "private.ts"), "export const secret = 'not exported';");
  await Bun.write(join(dir, "web/src/fs.ts"), "import { core } from '@bun-wasm/runtime/core'; import { views } from '@bun-wasm/runtime/core/memory-views'; export const shared = [core, views];");
  await Bun.write(main, "import { shared } from '../../web/src/fs'; console.log(shared);");
  await Bun.write(worker, "import { shared } from './fs'; postMessage(shared);");
  expect(() => Bun.resolveSync("@bun-wasm/runtime/core", join(dir, "web/src"))).toThrow();
  expect(await Bun.file(join(dir, "web/node_modules/@bun-wasm/runtime/package.json")).exists()).toBe(false);
  return { dir, main, worker };
}

test("sandbox-only install resolves shared web sources through the consumer's package exports", async () => {
  const { dir, main, worker } = await sandboxOnlyInstall();
  const result = await buildBrowserEntries([main, worker], join(dir, "sandbox/dist"));
  const javascript = (await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map((output) => output.text()))).join("\n");
  expect(javascript).toContain("core from sandbox install");
  expect(javascript).toContain("views from sandbox install");
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some((path) => path.endsWith("sandbox/node_modules/@bun-wasm/runtime/dist/public-core.ts"))).toBe(true);
  expect(inputs.some((path) => path.endsWith("sandbox/node_modules/@bun-wasm/runtime/dist/public-views.ts"))).toBe(true);
});

test("consumer runtime resolution does not expose unexported package files", async () => {
  const { dir, main, worker } = await sandboxOnlyInstall();
  await Bun.write(join(dir, "web/src/fs.ts"), "import { secret } from '@bun-wasm/runtime/private.ts'; export const shared = secret;");
  await expect(buildBrowserEntries([main, worker], join(dir, "sandbox/dist"))).rejects.toThrow();
});

test("service worker remains a standalone classic script alongside split entries", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.split-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "shared.ts"), "export const value = 'classic';");
  await Bun.write(join(dir, "sw.ts"), "import { value } from './shared'; self.addEventListener('message', event => event.source.postMessage(value));");
  const result = await buildClassicWorker(join(dir, "sw.ts"), join(dir, "dist"));
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0]!.text();
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).not.toMatch(/\bexport\s/);
});
