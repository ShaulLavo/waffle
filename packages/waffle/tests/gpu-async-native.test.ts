import { expect, test } from "bun:test";
import {
  asyncNativeControls,
  asyncNativeRoutes,
  requireAsyncNativeResult,
} from "./gpu-async-native.ts";
test("async native suite exports four strict controls and bundles without Bun test code", async () => {
  expect(asyncNativeControls).toEqual([
    "metadata",
    "mapping",
    "scopes-compilation-work-loss",
    "mapping-negative",
  ]);
  expect((await asyncNativeRoutes())["/async-native.js"].size).toBeGreaterThan(0);
});
for (const result of [
  undefined,
  null,
  { control: "mapping", compiledGuest: false, status: "skipped", kind: "native-lowering-control" },
  { control: "mapping", compiledGuest: true, status: "passed", kind: "native-lowering-control" },
  { control: "mapping", compiledGuest: false, status: "passed" },
])
  test(`async control rejects incomplete acceptance ${JSON.stringify(result)}`, () => {
    expect(() => requireAsyncNativeResult(result, "mapping")).toThrow();
  });
test("native host controls explicitly do not claim compiled guest acceptance", () => {
  expect(() =>
    requireAsyncNativeResult(
      {
        control: "mapping",
        compiledGuest: false,
        status: "passed",
        kind: "native-lowering-control",
      },
      "mapping",
    ),
  ).not.toThrow();
});
