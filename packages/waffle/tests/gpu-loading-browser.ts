import { basename } from "node:path";
import type { Page } from "playwright";
export async function gpuLazyRoutes() {
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/gpu/lazy-page.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    metafile: true,
    naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
  });
  if (!build.success || !build.metafile) throw new Error(build.logs.join("\n"));
  const routes: Record<string, Blob> = {};
  for (const output of build.outputs) routes[`/${basename(output.path)}`] = output;
  const outputInputs = Object.fromEntries(
    Object.entries(build.metafile.outputs).map(([path, output]) => [
      `/${basename(path)}`,
      Object.keys(output.inputs),
    ]),
  );
  return { routes, outputInputs };
}
export async function assertGpuLazyBrowser(
  page: Page,
  url: string,
  outputInputs: Record<string, string[]>,
) {
  await page.goto(url);
  const evidence = [];
  for (const stage of ["filesystem", "display", "process", "dispose"] as const) {
    const snapshot = await page.evaluate(async (stage) => {
      const path = "/lazy-page.js",
        module: typeof import("./fixtures/gpu/lazy-page.js") = await import(path);
      return module.lazy(stage);
    }, stage);
    const inputs = snapshot.resources.flatMap((path) => outputInputs[path] ?? []);
    if (inputs.some((path) => /browser\/gpu\//.test(path)))
      throw new Error(`${stage} eagerly loaded GPU implementation`);
    if (
      stage !== "process" &&
      stage !== "dispose" &&
      inputs.some((path) => /proc\/(?:supervisor|table|registry)\.ts$/.test(path))
    )
      throw new Error(`${stage} eagerly loaded process implementation`);
    if (stage === "display" && snapshot.workers.length !== 1)
      throw new Error("Display-only started another worker");
    if (stage === "dispose" && snapshot.workers.some((worker) => !worker.stopped))
      throw new Error("Lazy resource worker leaked");
    evidence.push({ stage, ...snapshot });
  }
  return evidence;
}
