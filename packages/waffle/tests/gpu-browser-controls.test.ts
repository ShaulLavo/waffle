import { expect, test } from "bun:test";
import { requireIntegrationAdapter } from "./gpu-browser-runner.js";

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
