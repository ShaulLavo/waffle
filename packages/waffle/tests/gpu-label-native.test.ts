import { expect, test } from "bun:test";
import { labelNativeControl } from "./fixtures/gpu/label-native.ts";
import { labelNativeRoutes } from "./gpu-label-native.ts";

test("native label reflection control bundles without Bun test code", async () => {
  expect(typeof labelNativeControl).toBe("function");
  expect((await labelNativeRoutes())["/label.js"].size).toBeGreaterThan(0);
});
