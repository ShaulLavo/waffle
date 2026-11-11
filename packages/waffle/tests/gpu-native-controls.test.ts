import { expect, test } from "bun:test";
import { runNativeBrowser } from "./gpu-native-browser-runner.ts";
import {
  requireNativeControlResult,
  runNativeControls,
  type NativeControlInvocation,
} from "./gpu-native-controls.ts";
import { sceneNativeControls } from "./gpu-scene-native.ts";
import { computeNativeControls } from "./gpu-compute-native.ts";
import { bundleQueryNativeControls } from "./gpu-bundle-query-native.ts";
import { copyDrawNativeControls } from "./gpu-copy-draw-native.ts";
import { asyncNativeControls } from "./gpu-async-native.ts";

const passed = (control: string) => ({ control, compiledGuest: false, status: "passed" });
const scenePassed = (control: string) => ({
  control,
  compiledGuest: false,
  kind: "native-lowering-control",
});
function passedInvocation({ path, control }: NativeControlInvocation) {
  if (path === "/scene.js") return scenePassed(control);
  if (path === "/async-native.js") return { ...scenePassed(control), status: "passed" };
  return passed(control);
}

test("aggregate preserves the historical 53 controls and appends four strict async controls once", async () => {
  const invoked: string[] = [];
  const reported: Record<string, unknown>[] = [];
  const count = await runNativeControls(
    async ({ path, entry, control }) => {
      invoked.push(`${path}:${entry}:${control}`);
      return passedInvocation({ path, entry, control });
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
  expect(expected).toHaveLength(52);
  expect(invoked.slice(0, 52)).toEqual(expected);
  expect(invoked[52]).toBe("/label.js:labelNativeControl:labels");
  expect(asyncNativeControls).toEqual([
    "metadata",
    "mapping",
    "scopes-compilation-work-loss",
    "mapping-negative",
  ]);
  expect(invoked.slice(53)).toEqual(
    asyncNativeControls.map((control) => `/async-native.js:asyncNativeControl:${control}`),
  );
  expect(count).toBe(57);
  expect(new Set(invoked).size).toBe(57);
  expect(reported).toHaveLength(57);
  for (const result of reported)
    expect(result).toMatchObject({ kind: "native-lowering-control", compiledGuest: false });
});

test("negative native controls remain native successes, not compiled acceptance", () => {
  expect(() =>
    requireNativeControlResult(
      { ...passed("no-immediates"), status: "passed-negative-control" },
      "no-immediates",
      "copy-draw",
    ),
  ).not.toThrow();
  expect(() => requireNativeControlResult(scenePassed("normal"), "normal", "scene")).not.toThrow();
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
    expect(() => requireNativeControlResult(result, "normal", "compute")).toThrow();
  });

for (const failingCall of [4, 54, 55, 56, 57])
  for (const failure of ["throw", "unavailable"] as const)
    test(`native ${failure} at call ${failingCall} propagates without false success`, async () => {
      const reported: unknown[] = [];
      let calls = 0;
      const run = runNativeControls(
        async (invocation) => {
          const { control } = invocation;
          calls++;
          if (calls !== failingCall) return passedInvocation(invocation);
          if (failure === "throw") throw new Error("native validation regression");
          return { ...passed(control), status: "unavailable" };
        },
        (result) => reported.push(result),
      );
      await expect(run).rejects.toThrow(
        failure === "throw"
          ? "native validation regression"
          : failingCall > 53
            ? "Async native control failed"
            : "did not pass",
      );
      expect(calls).toBe(failingCall);
      expect(reported).toHaveLength(failingCall - 1);
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

test("unmarked native results cannot produce success-labelled reports", async () => {
  const reports: unknown[] = [];
  const run = runNativeControls(
    async ({ control }) => ({ control, compiledGuest: false }),
    (result) => reports.push(result),
  );
  await expect(run).rejects.toThrow();
  expect(reports).toHaveLength(0);
});

for (const suite of ["compute", "bundle-query", "copy-draw", "label"] as const) {
  test(`${suite} requires a passing status even when a native kind is present`, () => {
    expect(() => requireNativeControlResult(scenePassed("normal"), "normal", suite)).toThrow(
      "missing status",
    );
    expect(() =>
      requireNativeControlResult({ control: "normal", compiledGuest: false }, "normal", suite),
    ).toThrow();
  });
}

test("scene requires its native kind while valid copy/draw variants do not", () => {
  expect(() => requireNativeControlResult(passed("normal"), "normal", "scene")).toThrow(
    "Missing native result kind",
  );
  expect(() => requireNativeControlResult(scenePassed("normal"), "normal", "scene")).not.toThrow();
  expect(() =>
    requireNativeControlResult(passed("frame-copy"), "frame-copy", "copy-draw"),
  ).not.toThrow();
  expect(() =>
    requireNativeControlResult(
      { ...passed("frame-copy"), kind: "native-lowering-control" },
      "frame-copy",
      "copy-draw",
    ),
  ).not.toThrow();
});

for (const result of [
  { control: "metadata", compiledGuest: false },
  { ...passed("metadata") },
  { ...scenePassed("metadata") },
  { ...scenePassed("metadata"), status: "passed-negative-control" },
  { ...scenePassed("metadata"), status: "skipped" },
  { ...scenePassed("metadata"), status: "passed", compiledGuest: true },
])
  test(`async aggregate rejects incomplete or nonpassing native evidence: ${JSON.stringify(result)}`, () => {
    expect(() => requireNativeControlResult(result, "metadata", "async")).toThrow(
      "Async native control failed",
    );
  });
