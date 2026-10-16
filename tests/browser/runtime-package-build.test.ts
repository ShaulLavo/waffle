import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserBuildConfig } from "../../scripts/browser-build";

test("shared sources build through the consumer export when its package cache contains dots", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-runtime-build-"));
  try {
    const consumer = join(scratch, "consumer");
    const cached = join(scratch, "cache", "runtime..copy");
    const shared = join(scratch, "shared");
    for (const path of [join(consumer, "src"), join(consumer, "node_modules", "@bun-wasm"), cached, shared]) mkdirSync(path, { recursive: true });
    writeFileSync(join(cached, "package.json"), JSON.stringify({ name: "@bun-wasm/runtime", type: "module", exports: { "./core": "./core.js", "./core/memory-views": "./memory-views.js" } }));
    writeFileSync(join(cached, "core.js"), 'export const marker = "consumer-core";');
    writeFileSync(join(cached, "memory-views.js"), 'export const marker = "consumer-memory";');
    symlinkSync(cached, join(consumer, "node_modules", "@bun-wasm", "runtime"));
    const main = join(consumer, "src", "main.ts");
    const worker = join(shared, "worker.ts");
    writeFileSync(main, 'import { marker } from "@bun-wasm/runtime/core"; console.log(marker);');
    writeFileSync(worker, 'import { marker } from "@bun-wasm/runtime/core/memory-views"; console.log(marker);');
    const result = await Bun.build({ ...browserBuildConfig([main, worker], join(scratch, "dist")), throw: false });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    expect(result.success).toBe(true);
    const scripts = result.outputs.filter(output => output.path.endsWith(".js"));
    const text = (await Promise.all(scripts.map(output => output.text()))).join("\n");
    expect(text).toContain("consumer-core");
    expect(text).toContain("consumer-memory");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
