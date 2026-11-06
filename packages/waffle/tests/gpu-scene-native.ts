import { resolve } from "node:path";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";
import { browserBundle } from "./browser-runner-lifecycle.js";

export const sceneNativeControls = ["normal", "no-depth", "black-texture"];

export async function sceneNativeRoutes() {
  return {
    "/": "<!doctype html><title>GPU scene native lowering control</title>",
    "/scene.js": await browserBundle(resolve(import.meta.dir, "fixtures/gpu/scene-native.ts")),
  };
}
export async function runSceneNative() {
  const runner = new GpuQualificationLifecycle(60_000);
  try {
    await runner.init(process.env.TMPDIR ?? "/work/tmp");
    const url = runner.serve(await sceneNativeRoutes());
    console.log(JSON.stringify({ stage: "setup", scratch: runner.scratch, url }));
    const browser = await runner.launch("chromium");
    const page = await browser.newPage();
    await page.goto(url);
    for (const control of sceneNativeControls) {
      const result: unknown = await page.evaluate(async (name) => {
        const path = "/scene.js";
        const module = await import(path);
        return module.sceneNativeControl(name);
      }, control);
      console.log(JSON.stringify({ browser: browser.version(), result }));
    }
  } finally {
    await runner.close();
    console.log(JSON.stringify({ stage: "cleanup", stopped: true, removed: runner.scratch }));
  }
}
if (import.meta.main) await runSceneNative();
