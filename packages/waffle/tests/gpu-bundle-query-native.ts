import type { Page } from "playwright";
import { resolve } from "node:path";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";
import { browserBundle } from "./browser-runner-lifecycle.js";

export const bundleQueryNativeControls = [
  "direct",
  "indexed",
  "indirect",
  "indexed-indirect",
  "no-execute",
  "no-query",
  "no-resolve",
  "immediate",
  "zero-immediates",
  "no-immediates",
  "timestamp",
  "no-timestamp",
];

export async function bundleQueryNativeRoutes() {
  return {
    "/": "<!doctype html><title>Native render bundle and query controls</title>",
    "/bundle-query.js": await browserBundle(
      resolve(import.meta.dir, "fixtures/gpu/bundle-query-native.ts"),
    ),
  };
}
async function invokeControl(page: Page, control: string): Promise<unknown> {
  return page.evaluate(async (name) => {
    const path = "/bundle-query.js";
    const entry: typeof import("./fixtures/gpu/bundle-query-native.js") = await import(path);
    return entry.bundleQueryNativeControl(name);
  }, control);
}
async function run() {
  const lifecycle = new GpuQualificationLifecycle(90_000);
  try {
    await lifecycle.init(process.env.TMPDIR ?? "/work/tmp");
    const endpoint = lifecycle.serve(await bundleQueryNativeRoutes());
    console.log(JSON.stringify({ phase: "setup", scratch: lifecycle.scratch, endpoint }));
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await page.goto(endpoint);
    for (const control of bundleQueryNativeControls) {
      const result = await invokeControl(page, control);
      console.log(JSON.stringify({ browser: browser.version(), result }));
    }
  } finally {
    await lifecycle.close();
    console.log(JSON.stringify({ phase: "cleanup", removed: lifecycle.scratch, stopped: true }));
  }
}
if (import.meta.main) await run();
