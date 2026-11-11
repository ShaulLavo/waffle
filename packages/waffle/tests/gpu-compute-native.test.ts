import { expect, test } from "bun:test";
import { computeNativeControl } from "./fixtures/gpu/compute-native.ts";
import { computeNativeRoutes } from "./gpu-compute-native.ts";

test("compute native controls bundle without importing Bun tests into the browser", async () => {
  expect(typeof computeNativeControl).toBe("function");
  const routes = await computeNativeRoutes();
  expect(routes["/compute.js"].size).toBeGreaterThan(0);
});
