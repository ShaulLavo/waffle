import { mkdir, readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { swiftShaderArgs } from "../gpu-browser-qualification.js";
import { gpuAsyncAdapter } from "./gpu-async-suite.js";
import { PlaywrightDriver } from "./playwright-driver.js";

export async function runGpuAsyncFailureControls(root: string, scratch: string, startedAt: number) {
  if (!isAbsolute(root) || !isAbsolute(scratch)) throw new Error("Control paths must be absolute");
  await mkdir(root, { recursive: true });
  await mkdir(scratch);
  try {
    for (const mode of ["missing-wasm", "wrong-wasm", "cancel-after-open"] as const) {
      const adapter = gpuAsyncAdapter("chromium"),
        controller = new AbortController();
      const result = await runPageSuite(
        {
          ...adapter,
          async assets(context) {
            const assets = await adapter.assets(context);
            if (mode === "missing-wasm") delete assets["/async.wasm"];
            if (mode === "wrong-wasm")
              assets["/async.wasm"] = new Blob([new Uint8Array([0])], { type: "application/wasm" });
            return assets;
          },
          inventory: () =>
            adapter.inventory().map((item) => ({
              ...item,
              drive:
                mode === "cancel-after-open"
                  ? async (host) => {
                      await host.task(
                        "window.__gpuAsync.value = await window.__gpuAsync.capabilities();",
                      );
                      await host.task('await window.__gpuAsync.invoke("openAsync", []);');
                      controller.abort("cancel-after-open");
                      await host.sleep(20);
                    }
                  : item.drive,
            })),
        },
        (path) => new PlaywrightDriver("chromium", path, swiftShaderArgs),
        {
          resultPath: join(root, `${mode}.json`),
          scratchRoot: scratch,
          signal: controller.signal,
          startedAt,
        },
      );
      const id = result.required[0],
        outcome = id && result.outcomes[id];
      const expected =
        mode === "missing-wasm"
          ? "Missing verified C async fixture"
          : mode === "wrong-wasm"
            ? "Truncated declaration section"
            : "cancel-after-open";
      if (
        result.exit === 0 ||
        (mode !== "cancel-after-open" &&
          (typeof outcome !== "object" ||
            outcome.status !== "fail" ||
            !outcome.detail.includes(expected))) ||
        (mode === "cancel-after-open" &&
          !result.failures.some(({ category }) => category === "interrupted"))
      )
        throw new Error(`GPU async ${mode} failure was not observed: ${JSON.stringify(result)}`);
      if (
        [
          result.cleanup.session,
          result.cleanup.launcher,
          result.cleanup.server,
          result.cleanup.scratch,
        ].some((step) => step.status !== "confirmed")
      )
        throw new Error(`GPU async ${mode} cleanup unconfirmed: ${JSON.stringify(result.cleanup)}`);
      if ((await readdir(scratch)).length)
        throw new Error("GPU failure control retained owned scratch");
      console.log(
        JSON.stringify({
          mode,
          exit: result.exit,
          outcomes: result.outcomes,
          failures: result.failures,
          cleanup: result.cleanup,
        }),
      );
    }
  } finally {
    if ((await readdir(scratch)).length === 0) await rmdir(scratch);
  }
}
