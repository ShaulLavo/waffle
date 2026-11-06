import { resolve } from "node:path";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";
import { browserBundle } from "./browser-runner-lifecycle.js";

export const computeNativeControls = [
  "direct",
  "auto",
  "indirect",
  "no-dispatch",
  "immediate-auto",
  "immediate-explicit",
];

export async function computeNativeRoutes() {
  const module = await browserBundle(resolve(import.meta.dir, "fixtures/gpu/compute-native.ts"));
  return {
    "/": "<!doctype html><title>Native compute lowering controls</title>",
    "/compute.js": module,
  };
}
async function runComputeNative() {
  const lifecycle = new GpuQualificationLifecycle(90_000);
  try {
    await lifecycle.init(process.env.TMPDIR ?? "/work/tmp");
    const endpoint = lifecycle.serve(await computeNativeRoutes());
    console.log(JSON.stringify({ phase: "setup", scratch: lifecycle.scratch, endpoint }));
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await page.goto(endpoint);
    const results: unknown[] = [];
    for (const control of computeNativeControls) {
      const result: unknown = await page.evaluate(async (name) => {
        const path = "/compute.js";
        const entry = await import(path);
        return entry.computeNativeControl(name);
      }, control);
      results.push(result);
      console.log(JSON.stringify({ browser: browser.version(), result }));
    }
    return results;
  } finally {
    await lifecycle.close();
    console.log(JSON.stringify({ phase: "cleanup", removed: lifecycle.scratch, stopped: true }));
  }
}
if (import.meta.main) await runComputeNative();
