import { resolve } from "node:path";
import { verifiedGpuAsyncFixture } from "../scripts/build-gpu-fixture.js";
import { browserBundle } from "./browser-runner-lifecycle.js";
import { qualificationRoutes } from "./gpu-browser-qualification.js";

export function asyncFixture() {
  const directory = process.env.GPU_FIXTURE_DIR;
  if (!directory) throw new Error("Set GPU_FIXTURE_DIR to the once-built producer output");
  return verifiedGpuAsyncFixture(resolve(directory));
}
export async function asyncRoutes(wasm: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const routes = await qualificationRoutes();
  for (const [route, source] of [
    ["/async-page.js", "./fixtures/gpu/async-page.ts"],
    ["/gpu-guest.js", "./fixtures/gpu/integration-guest.ts"],
    ["/gpu/service-worker.ts", "./fixtures/gpu/integration-service-worker.ts"],
    ["/fs-worker.js", "../browser/fs-worker.ts"],
    ["/gpu-async-operations.js", "./page-runner/gpu-async-operations.ts"],
  ]) {
    signal?.throwIfAborted();
    if (!route || !source) throw new Error("Invalid async route");
    routes[route] = await browserBundle(new URL(source, import.meta.url).pathname);
  }
  signal?.throwIfAborted();
  routes["/async.wasm"] = new Blob([wasm], { type: "application/wasm" });
  return routes;
}
