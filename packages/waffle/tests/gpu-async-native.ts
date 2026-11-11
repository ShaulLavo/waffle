import { fileURLToPath } from "node:url";
import { navigateTestPage } from "./browser-navigation.js";
import { browserBundle } from "./browser-runner-lifecycle.js";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";

export const asyncNativeControls = [
  "metadata",
  "mapping",
  "scopes-compilation-work-loss",
  "mapping-negative",
];
export async function asyncNativeRoutes() {
  return {
    "/": "<!doctype html><title>G2 native controls, not compiled guest acceptance</title>",
    "/async-native.js": await browserBundle(
      fileURLToPath(new URL("./fixtures/gpu/async-native.ts", import.meta.url)),
    ),
  };
}
async function runAsyncNativeControls(): Promise<void> {
  const lifecycle = new GpuQualificationLifecycle(120000);
  try {
    await lifecycle.init(process.env.GPU_SCRATCH_ROOT ?? process.env.TMPDIR);
    const url = lifecycle.serve(await asyncNativeRoutes());
    console.log(JSON.stringify({ phase: "async-native-setup", scratch: lifecycle.scratch, url }));
    const browser = await lifecycle.launch("chromium"),
      page = await browser.newPage();
    page.on("pageerror", (error) =>
      console.error(
        JSON.stringify({ phase: "native-page-error", message: error.message, stack: error.stack }),
      ),
    );
    page.on("console", (message) =>
      console.log(JSON.stringify({ phase: "native-console", text: message.text() })),
    );
    await navigateTestPage(page, url);
    for (const control of asyncNativeControls) {
      const result: unknown = await page.evaluate(async (control) => {
        const path = "/async-native.js";
        const module = await import(path);
        return module.asyncNativeControl(control);
      }, control);
      requireAsyncNativeResult(result, control);
      console.log(
        JSON.stringify({ phase: "async-native-result", browser: browser.version(), result }),
      );
    }
  } finally {
    await lifecycle.close();
    console.log(
      JSON.stringify({ phase: "async-native-cleanup", removed: lifecycle.scratch, stopped: true }),
    );
  }
}
export function requireAsyncNativeResult(result: unknown, control: string): void {
  if (
    !result ||
    typeof result !== "object" ||
    !("control" in result) ||
    result.control !== control ||
    !("status" in result) ||
    result.status !== "passed" ||
    !("compiledGuest" in result) ||
    result.compiledGuest !== false ||
    !("kind" in result) ||
    result.kind !== "native-lowering-control"
  )
    throw new Error(`Async native control failed ${control}: ${JSON.stringify(result)}`);
}
if (import.meta.main) await runAsyncNativeControls();
