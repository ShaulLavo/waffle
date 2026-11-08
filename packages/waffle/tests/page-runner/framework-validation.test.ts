import { expect, test } from "bun:test";
import { validateFrameworkOptions } from "./framework-validation.js";
import type { FrameworkOptions } from "./framework-types.js";

function options(timeoutMs: number): FrameworkOptions {
  return {
    suite: "case-clock-control",
    native: { udid: "not-launched" },
    expected: [
      {
        file: "original.ts",
        fullName: "required",
        sourceKey: "original:1",
        timeoutMs,
        retries: 0,
      },
    ],
    scope: { kind: "root-selection", command: "test:browser", files: ["original.ts"] },
    resultPath: "/unused-case-clock-control.json",
  };
}

for (const timeoutMs of [1000, 15000, 20000, 30000]) {
  test(`expected inventory preserves original ${timeoutMs} ms case clock`, () => {
    const input = options(timeoutMs);
    expect(() => validateFrameworkOptions(input)).not.toThrow();
    expect(input.expected[0]?.timeoutMs).toBe(timeoutMs);
    expect(input.expected[0]?.retries).toBe(0);
  });
}

for (const timeoutMs of [undefined, null, "20000", false, 0, -1, NaN, Infinity, -Infinity]) {
  test(`expected inventory rejects invalid clock ${String(timeoutMs)}`, () => {
    const input = options(15000);
    const item = input.expected[0];
    if (!item) throw new Error("Missing fixture case");
    Reflect.set(item, "timeoutMs", timeoutMs);
    expect(() => validateFrameworkOptions(input)).toThrow(
      "Invalid expected case identity or original clock",
    );
  });
}

test("nondefault clocks do not permit retries", () => {
  const input = options(20000);
  const item = input.expected[0];
  if (!item) throw new Error("Missing fixture case");
  Reflect.set(item, "retries", 1);
  expect(() => validateFrameworkOptions(input)).toThrow(
    "Invalid expected case identity or original clock",
  );
});
