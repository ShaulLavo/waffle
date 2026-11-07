import { navigateTestPage } from "./browser-navigation.js";
import type { Page } from "playwright";
import { GpuQualificationLifecycle } from "./gpu-browser-qualification.js";
import {
  nativeControlRoutes,
  runNativeControls,
  type NativeControlInvocation,
} from "./gpu-native-controls.js";

function invokeNativeControl(page: Page, invocation: NativeControlInvocation): Promise<unknown> {
  return page.evaluate(async ({ path, entry, control }) => {
    const module: unknown = await import(path);
    if (!module || typeof module !== "object") throw new Error(`Missing native module: ${path}`);
    const run: unknown = Reflect.get(module, entry);
    if (typeof run !== "function") throw new Error(`Missing native control entry: ${entry}`);
    return run(control);
  }, invocation);
}

export async function runNativeBrowser(engines: readonly string[]): Promise<void> {
  if (engines.length !== 1 || engines[0] !== "chromium")
    throw new Error("G1 native controls require exactly one designated-SwiftShader Chromium lane");
  const lifecycle = new GpuQualificationLifecycle();
  try {
    await lifecycle.init(process.env.GPU_SCRATCH_ROOT ?? process.env.TMPDIR);
    const url = lifecycle.serve(await nativeControlRoutes());
    console.log(JSON.stringify({ phase: "native-setup", scratch: lifecycle.scratch, url }));
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    await navigateTestPage(page, url);
    const count = await runNativeControls((invocation) => invokeNativeControl(page, invocation));
    console.log(
      JSON.stringify({
        phase: "native-complete",
        browser: browser.version(),
        compiledGuest: false,
        count,
      }),
    );
  } finally {
    await lifecycle.close();
    console.log(
      JSON.stringify({ phase: "native-cleanup", removed: lifecycle.scratch, stopped: true }),
    );
  }
}

if (import.meta.main) await runNativeBrowser(process.argv.slice(2));
