import { browserBundle } from "./browser-runner-lifecycle.js";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";

export async function copyDrawNativeRoutes() {
  return {
    "/": "<!doctype html><title>Copy/draw native lowering controls</title>",
    "/copy-draw.js": await browserBundle(
      new URL("./fixtures/gpu/copy-draw-native.ts", import.meta.url).pathname,
    ),
  };
}
async function main() {
  const lifecycle = new GpuQualificationLifecycle(120_000);
  try {
    await lifecycle.init(process.env.TMPDIR ?? "/work/tmp");
    const url = lifecycle.serve(await copyDrawNativeRoutes());
    console.log(JSON.stringify({ phase: "setup", scratch: lifecycle.scratch, url }));
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await page.goto(url);
    const controls = process.argv.slice(2);
    for (const control of controls.length
      ? controls
      : [
          "frame-copy",
          "copy",
          "changed-copy-input",
          "no-buffer-copy",
          "no-clear",
          "no-buffer-texture",
          "no-texture-copy",
          "no-texture-buffer",
          "indirect",
          "indexed-indirect",
          "no-draw",
          "no-stencil",
          "changed-stencil",
          "no-blend",
          "changed-blend",
          "no-viewport",
          "changed-viewport",
          "changed-depth-range",
          "no-scissor",
          "changed-scissor",
          "immediate",
          "zero-immediates",
          "immediate-invalid-length",
          "immediate-invalid-offset",
          "immediate-invalid-range",
          "destroy-buffer",
          "destroy-texture",
          "destroy-frame",
          "invalid-copy",
          "invalid-scissor",
          "webidl-viewport",
        ]) {
      const result: unknown = await page.evaluate(async (name) => {
        const path = "/copy-draw.js";
        const module: typeof import("./fixtures/gpu/copy-draw-native.js") = await import(path);
        return module.copyDrawNativeControl(name);
      }, control);
      console.log(JSON.stringify({ browser: browser.version(), result }));
    }
  } finally {
    await lifecycle.close();
    console.log(JSON.stringify({ phase: "cleanup", removed: lifecycle.scratch, stopped: true }));
  }
}
if (import.meta.main) await main();
