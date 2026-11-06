import { expect, test } from "bun:test";
import { runNativeBrowser } from "./gpu-native-browser-runner.ts";
import { requireNativeControlResult, runNativeControls } from "./gpu-native-controls.ts";
import { sceneNativeControls } from "./gpu-scene-native.ts";
import { computeNativeControls } from "./gpu-compute-native.ts";
import { bundleQueryNativeControls } from "./gpu-bundle-query-native.ts";
import { copyDrawNativeControls } from "./gpu-copy-draw-native.ts";

const passed = (control: string) => ({ control, compiledGuest: false, status: "passed" });

test("aggregate invokes all 52 existing native controls exactly once, not compiled guests", async () => {
  const invoked: string[] = [];
  const reported: Record<string, unknown>[] = [];
  const count = await runNativeControls(
    async ({ path, entry, control }) => {
      invoked.push(`${path}:${entry}:${control}`);
      return passed(control);
    },
    (result) => reported.push(result),
  );
  const expected = sceneNativeControls
    .map((control) => `/scene.js:sceneNativeControl:${control}`)
    .concat(
      computeNativeControls.map((control) => `/compute.js:computeNativeControl:${control}`),
      bundleQueryNativeControls.map(
        (control) => `/bundle-query.js:bundleQueryNativeControl:${control}`,
      ),
      copyDrawNativeControls.map((control) => `/copy-draw.js:copyDrawNativeControl:${control}`),
    );
  expect(count).toBe(52);
  expect(invoked).toEqual(expected);
  expect(new Set(invoked).size).toBe(52);
  expect(reported).toHaveLength(52);
  for (const result of reported)
    expect(result).toMatchObject({ kind: "native-lowering-control", compiledGuest: false });
});

test("negative native controls remain native successes, not compiled acceptance", () => {
  expect(() =>
    requireNativeControlResult(
      { ...passed("no-immediates"), status: "passed-negative-control" },
      "no-immediates",
    ),
  ).not.toThrow();
  expect(() =>
    requireNativeControlResult({ control: "normal", compiledGuest: false }, "normal"),
  ).not.toThrow();
});

for (const result of [
  undefined,
  null,
  false,
  { compiledGuest: false },
  { control: "wrong", compiledGuest: false },
  { control: "normal", compiledGuest: true },
  { control: "normal" },
  { ...passed("normal"), kind: "compiled-guest" },
  { ...passed("normal"), status: "unavailable" },
  { ...passed("normal"), status: "failed" },
  { ...passed("normal"), status: "skipped" },
])
  test(`native result rejection: ${JSON.stringify(result)}`, () => {
    expect(() => requireNativeControlResult(result, "normal")).toThrow();
  });

for (const failure of ["throw", "unavailable"] as const)
  test(`native ${failure} propagates without reporting a false success`, async () => {
    const reported: unknown[] = [];
    let calls = 0;
    const run = runNativeControls(
      async ({ control }) => {
        calls++;
        if (calls !== 4) return passed(control);
        if (failure === "throw") throw new Error("native validation regression");
        return { ...passed(control), status: "unavailable" };
      },
      (result) => reported.push(result),
    );
    await expect(run).rejects.toThrow(
      failure === "throw" ? "native validation regression" : "did not pass",
    );
    expect(calls).toBe(4);
    expect(reported).toHaveLength(3);
  });

for (const engines of [
  [],
  ["firefox"],
  ["webkit"],
  ["chromium", "firefox"],
  ["chromium", "chromium"],
])
  test(`native lane rejects wrong or repeated engines: ${engines}`, async () => {
    await expect(runNativeBrowser(engines)).rejects.toThrow(
      "exactly one designated-SwiftShader Chromium",
    );
  });
