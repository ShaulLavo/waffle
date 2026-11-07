import { navigateTestPage } from "./browser-navigation.js";
import { browserBundle } from "./browser-runner-lifecycle.js";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";

export const labelNativeControls = ["labels"];
export async function labelNativeRoutes() {
  return {
    "/": "<!doctype html><title>Label native lowering control, not compiled guest acceptance</title>",
    "/label.js": await browserBundle(
      new URL("./fixtures/gpu/label-native.ts", import.meta.url).pathname,
    ),
  };
}
async function runLabels() {
  const lifecycle = new GpuQualificationLifecycle(90_000);
  try {
    await lifecycle.init(process.env.GPU_SCRATCH_ROOT ?? process.env.TMPDIR);
    const endpoint = lifecycle.serve(await labelNativeRoutes());
    console.log(JSON.stringify({ phase: "label-setup", scratch: lifecycle.scratch, endpoint }));
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await navigateTestPage(page, endpoint);
    const result: unknown = await page.evaluate(async () => {
      const path = "/label.js";
      const module = await import(path);
      return module.labelNativeControl("labels");
    });
    console.log(JSON.stringify({ phase: "label-complete", browser: browser.version(), result }));
  } finally {
    await lifecycle.close();
    console.log(
      JSON.stringify({ phase: "label-cleanup", removed: lifecycle.scratch, stopped: true }),
    );
  }
}
if (import.meta.main) await runLabels();
