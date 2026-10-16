import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { browserBuildConfig } from "../../scripts/browser-build";
import { filesystemBaselinePlugin } from "./filesystem-bench-baseline";

test("a baseline reexport resolves its own runtime, never the head consumer package", async () => {
  const root = await mkdtemp(resolve(import.meta.dir, "../node_modules/.baseline-resolution-"));
  try {
    const baseline = join(root, "baseline"), head = join(root, "head/web");
    const main = join(head, "main.ts");
    const manifest = JSON.stringify({ name: "@bun-wasm/runtime", type: "module", exports: { "./fs/memory": "./memory.ts" } });
    await Bun.write(join(baseline, "runtime/package.json"), manifest);
    await Bun.write(join(baseline, "runtime/memory.ts"), 'export const marker = "baseline";');
    await Bun.write(join(baseline, "web/src/fs.ts"), 'export * from "@bun-wasm/runtime/fs/memory";');
    await Bun.write(join(head, "node_modules/@bun-wasm/runtime/package.json"), manifest);
    await Bun.write(join(head, "node_modules/@bun-wasm/runtime/memory.ts"), 'export const marker = "head";');
    await Bun.write(main, 'import {marker as baseline} from "benchmark:baseline-fs"; import {marker as head} from "@bun-wasm/runtime/fs/memory"; globalThis.__filesystemBaselineFixture = [baseline, head];');
    async function run(fixed: boolean): Promise<unknown> {
      const config = browserBuildConfig([main], join(root, "dist"));
      config.plugins!.unshift(fixed ? filesystemBaselinePlugin(baseline) : { name: "old-alias-only", setup(build) {
        build.onResolve({ filter: /^benchmark:baseline-/ }, () => ({ path: join(baseline, "web/src/fs.ts") }));
      } });
      const result = await Bun.build(config);
      expect(result.success).toBe(true);
      const text = await result.outputs.find(output => output.path.endsWith("main.js"))!.text();
      new Function(text)();
      return (globalThis as any).__filesystemBaselineFixture;
    }
    expect(await run(false)).toEqual(["head", "head"]); // Reproduces the former contaminated direct arm.
    expect(await run(true)).toEqual(["baseline", "head"]);
  } finally {
    delete (globalThis as any).__filesystemBaselineFixture;
    await rm(root, { recursive: true, force: true });
  }
});
