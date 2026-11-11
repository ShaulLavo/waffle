import { expect, test } from "bun:test";
import { copyDrawNativeRoutes } from "./gpu-copy-draw-native.ts";
import { copyDrawNativeControl } from "./fixtures/gpu/copy-draw-native.ts";

test("copy/draw native controls bundle without test or Bun dependencies in the browser", async () => {
  expect(typeof copyDrawNativeControl).toBe("function");
  const routes = await copyDrawNativeRoutes();
  expect(routes["/copy-draw.js"].size).toBeGreaterThan(0);
});
