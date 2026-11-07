import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const relocated = [
  "tests/gpu-browser-qualification.ts",
  "tests/gpu-async-assets.ts",
  "tests/gpu-async-native.ts",
  "tests/gpu-label-native.ts",
  "tests/gpu-copy-draw-native.ts",
  "tests/gpu-loading-browser.ts",
  "tooling/gpu-measure.ts",
];

function relocate(source: string, target: string, copies: readonly string[]): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry),
      to = join(target, entry);
    const nested = copies
      .filter((path) => path.startsWith(`${entry}/`))
      .map((path) => path.slice(entry.length + 1));
    if (nested.length) relocate(from, to, nested);
    else if (copies.includes(entry)) copyFileSync(from, to);
    else symlinkSync(from, to);
  }
}

let scratch = "";
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeAll(() => {
  scratch = mkdtempSync(join(process.env.GPU_SCRATCH_ROOT ?? tmpdir(), "waffle-gpu-path-"));
});

for (const name of ["space root", "literal %20 café"]) {
  test(`GPU assets bundle from a filesystem path containing ${name}`, async () => {
    const root = join(scratch, name);
    relocate(resolve(import.meta.dir, ".."), root, relocated);
    const url = (path: string) => pathToFileURL(join(root, path)).href;
    const qualification: typeof import("./gpu-browser-qualification.js") = await import(
      url("tests/gpu-browser-qualification.ts")
    );
    const qualified = await qualification.qualificationRoutes();
    expect(Object.keys(qualified)).toEqual([
      "/",
      "/qualification-page.js",
      "/qualification-worker.js",
    ]);
    expect(await new Response(qualified["/qualification-worker.js"]).text()).toContain(
      "transferFromImageBitmap",
    );

    const asyncAssets: typeof import("./gpu-async-assets.js") = await import(
      url("tests/gpu-async-assets.ts")
    );
    const wasm = new Uint8Array([0, 97, 115, 109]);
    const routes = await asyncAssets.asyncRoutes(wasm);
    expect(Object.keys(routes)).toEqual([
      "/",
      "/qualification-page.js",
      "/qualification-worker.js",
      "/async-page.js",
      "/gpu-guest.js",
      "/gpu/service-worker.ts",
      "/fs-worker.js",
      "/gpu-async-operations.js",
      "/async.wasm",
    ]);
    expect(new Uint8Array(await new Response(routes["/async.wasm"]).arrayBuffer())).toEqual(wasm);
    for (const [route, body] of Object.entries(routes)) {
      if (route.endsWith(".wasm") || typeof body === "string") continue;
      expect(body.size).toBeGreaterThan(0);
    }

    const nativeAsync: typeof import("./gpu-async-native.js") = await import(
      url("tests/gpu-async-native.ts")
    );
    expect((await nativeAsync.asyncNativeRoutes())["/async-native.js"].size).toBeGreaterThan(0);
    const labels: typeof import("./gpu-label-native.js") = await import(
      url("tests/gpu-label-native.ts")
    );
    expect((await labels.labelNativeRoutes())["/label.js"].size).toBeGreaterThan(0);
    const copyDraw: typeof import("./gpu-copy-draw-native.js") = await import(
      url("tests/gpu-copy-draw-native.ts")
    );
    expect((await copyDraw.copyDrawNativeRoutes())["/copy-draw.js"].size).toBeGreaterThan(0);
    const loading: typeof import("./gpu-loading-browser.js") = await import(
      url("tests/gpu-loading-browser.ts")
    );
    expect((await loading.gpuLazyRoutes()).routes["/lazy-page.js"]?.size).toBeGreaterThan(0);
    const measurements: typeof import("../tooling/gpu-measure.js") = await import(
      url("tooling/gpu-measure.ts")
    );
    const { defaultMeasurementOptions } = await import("./fixtures/gpu/measurement-contract.js");
    const measured = await measurements.gpuMeasurementRoutes(defaultMeasurementOptions);
    expect(Object.keys(measured)).toEqual([
      "/",
      "/measurement-page.js",
      "/measurement-worker.js",
      "/measurement-options.json",
    ]);
  }, 30_000);
}
