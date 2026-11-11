import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sceneNativeRoutes } from "./gpu-scene-native.ts";

test("bounded native lowering control bundles independently of guest acceptance", async () => {
  const routes = await sceneNativeRoutes();
  expect(routes["/scene.js"].size).toBeGreaterThan(0);
  const runner = readFileSync(new URL("./gpu-scene-native.ts", import.meta.url), "utf8");
  expect(runner).toContain("finally");
  expect(runner).toContain("await runner.close()");
  const fixture = readFileSync(new URL("./fixtures/gpu/scene-native.ts", import.meta.url), "utf8");
  expect(fixture).toContain("compiledGuest: false");
  expect(fixture).toContain("connection.close()");
});
