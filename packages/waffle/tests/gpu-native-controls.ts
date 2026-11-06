import { sceneNativeControls, sceneNativeRoutes } from "./gpu-scene-native.js";
import { computeNativeControls, computeNativeRoutes } from "./gpu-compute-native.js";
import { bundleQueryNativeControls, bundleQueryNativeRoutes } from "./gpu-bundle-query-native.js";
import { copyDrawNativeControls, copyDrawNativeRoutes } from "./gpu-copy-draw-native.js";

const suites = [
  {
    name: "scene",
    path: "/scene.js",
    entry: "sceneNativeControl",
    controls: sceneNativeControls,
    routes: sceneNativeRoutes,
  },
  {
    name: "compute",
    path: "/compute.js",
    entry: "computeNativeControl",
    controls: computeNativeControls,
    routes: computeNativeRoutes,
  },
  {
    name: "bundle-query",
    path: "/bundle-query.js",
    entry: "bundleQueryNativeControl",
    controls: bundleQueryNativeControls,
    routes: bundleQueryNativeRoutes,
  },
  {
    name: "copy-draw",
    path: "/copy-draw.js",
    entry: "copyDrawNativeControl",
    controls: copyDrawNativeControls,
    routes: copyDrawNativeRoutes,
  },
];

export type NativeControlInvocation = { path: string; entry: string; control: string };
type Invoke = (invocation: NativeControlInvocation) => Promise<unknown>;

export async function nativeControlRoutes(): Promise<Record<string, Blob | string>> {
  const routes: Record<string, Blob | string> = {};
  for (const suite of suites) Object.assign(routes, await suite.routes());
  routes["/"] =
    "<!doctype html><title>G1 native lowering controls, not compiled guest acceptance</title>";
  return routes;
}

export function requireNativeControlResult(result: unknown, control: string): void {
  if (!result || typeof result !== "object") throw new Error(`Missing native result: ${control}`);
  if (!("control" in result) || result.control !== control)
    throw new Error(`Wrong native control result: ${control}`);
  if (!("compiledGuest" in result) || result.compiledGuest !== false)
    throw new Error(`Native control must not claim compiled guest acceptance: ${control}`);
  if ("kind" in result && result.kind !== "native-lowering-control")
    throw new Error(`Wrong native result kind: ${control}`);
  if (
    "status" in result &&
    result.status !== "passed" &&
    result.status !== "passed-negative-control"
  )
    throw new Error(`Required native control did not pass: ${control}: ${JSON.stringify(result)}`);
}

export async function runNativeControls(
  invoke: Invoke,
  report: (result: Record<string, unknown>) => void = (result) =>
    console.log(JSON.stringify(result)),
): Promise<number> {
  let count = 0;
  for (const suite of suites) {
    for (const control of suite.controls) {
      const result = await invoke({ path: suite.path, entry: suite.entry, control });
      requireNativeControlResult(result, control);
      report({
        kind: "native-lowering-control",
        compiledGuest: false,
        suite: suite.name,
        control,
        result,
      });
      count++;
    }
  }
  return count;
}
