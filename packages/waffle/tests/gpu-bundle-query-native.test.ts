import { expect, test } from "bun:test";
import { bundleQueryNativeControl } from "./fixtures/gpu/bundle-query-native.ts";
import { bundleQueryNativeRoutes } from "./gpu-bundle-query-native.ts";

test("native bundle/query controls bundle without Bun test code", async () => {
  expect(typeof bundleQueryNativeControl).toBe("function");
  expect((await bundleQueryNativeRoutes())["/bundle-query.js"].size).toBeGreaterThan(0);
});
