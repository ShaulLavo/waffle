import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";
import {
  assertFramePixels,
  assertBlankPixels,
  requireWorkerAdapter,
  GpuQualificationLifecycle,
  qualificationEngine,
  qualificationPort,
  qualificationRoutes,
} from "./gpu-browser-qualification.js";
import {
  pressureBurst,
  pressurePolicy,
  retentionSampleMs,
  qualificationRequest,
} from "./fixtures/gpu/qualification-contract.js";

test("qualification engine and loopback port inputs reject invalid configuration", () => {
  expect(qualificationEngine("chromium")).toBe("chromium");
  expect(qualificationEngine("firefox")).toBe("firefox");
  expect(qualificationEngine("webkit")).toBe("webkit");
  expect(() => qualificationEngine("chrome")).toThrow("Unknown");
  expect(qualificationPort()).toBe(0);
  expect(qualificationPort("43182")).toBe(43182);
  for (const port of ["-1", "65536", "NaN", "1.5", "", " 1"])
    expect(() => qualificationPort(port)).toThrow();
});

test("pixel oracle accepts red on blue and rejects the suppressed transfer", () => {
  assertFramePixels({ center: [255, 0, 0, 255], corner: [0, 0, 255, 255] });
  expect(() =>
    assertFramePixels({ center: [255, 255, 255, 255], corner: [255, 255, 255, 255] }),
  ).toThrow("pixel assertion");
  expect(() => assertFramePixels({ center: [255, 0, 0, 255], corner: [255, 0, 0, 255] })).toThrow();
  expect(() => assertFramePixels({ center: [], corner: [] })).toThrow();
});

test("retention deadlines cover the Firefox blanking window with bounded pressure", () => {
  expect(retentionSampleMs).toEqual([500, 3000, 8000, 14000]);
  expect(pressurePolicy).toEqual({ arrays: 4, bytesPerArray: 262144, intervalMs: 250 });
  expect(pressureBurst()).toBe(10);
});

test("qualification control parser rejects malformed commands", () => {
  expect(qualificationRequest({ kind: "bitmap", suppressTransfer: true })).toEqual({
    kind: "bitmap",
    suppressTransfer: true,
  });
  expect(qualificationRequest({ kind: "pressure" })).toEqual({ kind: "pressure" });
  for (const entry of [null, [], { kind: "bitmap" }, { kind: "unknown" }])
    expect(() => qualificationRequest(entry)).toThrow();
});

test("qualification page and worker bundle independently without runtime imports", async () => {
  const routes = await qualificationRoutes();
  expect(Object.keys(routes)).toEqual(["/", "/qualification-page.js", "/qualification-worker.js"]);
  const worker = routes["/qualification-worker.js"];
  if (!worker || typeof worker === "string") throw new Error("Missing worker bundle");
  const source = await worker.text();
  expect(source).toContain("transferFromImageBitmap");
  expect(source).toContain("stable-frame");
  expect(source).not.toContain("createRuntime");
});

test("Chromium never skips a missing software adapter; other engines report unsupported", () => {
  expect(requireWorkerAdapter("chromium", { adapter: { kind: "available" } })).toBe(true);
  for (const kind of ["missing-webgpu", "no-adapter"]) {
    expect(() => requireWorkerAdapter("chromium", { adapter: { kind } })).toThrow("SwiftShader");
    expect(requireWorkerAdapter("firefox", { adapter: { kind } })).toBe(false);
    expect(requireWorkerAdapter("webkit", { adapter: { kind } })).toBe(false);
  }
  expect(() => requireWorkerAdapter("webkit", { adapter: { kind: "unknown" } })).toThrow();
});

test("clear controls require a blank placeholder, not merely an incorrect frame", () => {
  assertBlankPixels({ center: [255, 255, 255, 255], corner: [255, 255, 255, 255] });
  expect(() => assertBlankPixels({ center: [255, 0, 0, 255], corner: [0, 0, 255, 255] })).toThrow();
  expect(() => assertBlankPixels({ center: [0, 255, 0, 255], corner: [0, 255, 0, 255] })).toThrow();
});

test("qualification reuses isolated loopback and removes owned scratch on failure", async () => {
  const runner = new GpuQualificationLifecycle(10_000);
  let url = "";
  try {
    await runner.init(process.env.GPU_QUALIFICATION_SCRATCH_ROOT ?? tmpdir());
    url = runner.serve({ "/": "qualification" }, 0);
    const response = await fetch(url);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(() => qualificationPort("invalid")).toThrow();
  } finally {
    await runner.close();
  }
  await expect(access(runner.scratch)).rejects.toThrow();
  await expect(fetch(url)).rejects.toThrow();
  await expect(runner.launch("chromium")).rejects.toThrow("not live");
  await runner.close();
});
