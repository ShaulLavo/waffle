import { expect, test } from "bun:test";
import { requireIntegrationAdapter, assertScenePixels } from "./gpu-browser-runner.js";

test("Chromium acceptance requires the actual designated SwiftShader adapter", () => {
  expect(
    requireIntegrationAdapter("chromium", {
      adapter: { kind: "available", architecture: "swiftshader" },
    }),
  ).toBe(true);
  expect(() =>
    requireIntegrationAdapter("chromium", {
      adapter: { kind: "available", architecture: "nvidia" },
    }),
  ).toThrow("SwiftShader");
  expect(() => requireIntegrationAdapter("chromium", { adapter: { kind: "available" } })).toThrow(
    "SwiftShader",
  );
  expect(() =>
    requireIntegrationAdapter("chromium", { adapter: { kind: "no-adapter" } }),
  ).toThrow();
});

test("unsupported engines keep their real no-WebGPU and no-adapter paths", () => {
  expect(requireIntegrationAdapter("firefox", { adapter: { kind: "no-adapter" } })).toBe(false);
  expect(requireIntegrationAdapter("webkit", { adapter: { kind: "missing-webgpu" } })).toBe(false);
});

test("compiled scene pixel gate distinguishes upload, binding and depth controls", () => {
  const normal = { left: [255, 0, 0, 255], right: [128, 0, 0, 255], corner: [0, 0, 255, 255] };
  const noDepth = { ...normal, left: [0, 255, 0, 255], right: [0, 128, 0, 255] };
  const black = { ...normal, left: [0, 0, 0, 255], right: [0, 0, 0, 255] };
  expect(() => assertScenePixels(normal)).not.toThrow();
  expect(() => assertScenePixels(noDepth, "no-depth")).not.toThrow();
  expect(() => assertScenePixels(black, "black-texture")).not.toThrow();
  expect(() => assertScenePixels(noDepth)).toThrow("Compiled scene pixel failure");
  expect(() => assertScenePixels(black)).toThrow("Compiled scene pixel failure");
  expect(() => assertScenePixels({ ...normal, right: normal.left })).toThrow();
  expect(() => assertScenePixels({ ...black, corner: black.left }, "black-texture")).toThrow();
});
