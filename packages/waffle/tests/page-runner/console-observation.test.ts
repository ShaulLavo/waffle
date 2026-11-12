import { expect, test } from "bun:test";
import { consoleMessage, consoleFailure, consoleExpired } from "./safari-console.js";
import { ConsoleObservation } from "./console-observation.js";

for (const [source, type, level, failure] of [
  ["javascript", undefined, "error", true],
  ["javascript", "other", "error", true],
  ["console-api", "log", "error", true],
  ["network", "log", "error", true],
  ["console-api", "assert", "error", false],
  ["console-api", "trace", "error", false],
  ["console-api", undefined, "error", false],
  ["console-api", "log", "warning", false],
] as const) {
  test(`original classification ${source} ${type} ${level}`, () => {
    const parsed = consoleMessage({ message: { source, type, level, text: "marker" } });
    expect(consoleFailure(parsed, true)).toBe(failure);
    if (type === undefined) expect(Object.hasOwn(parsed, "type")).toBe(false);
  });
}
test("optional protocol fields stay optional, malformed fields fail at boundary", () => {
  expect(
    consoleMessage({ message: { source: "javascript", level: "error", text: "marker" } }),
  ).toEqual({ source: "javascript", level: "error", text: "marker" });
  for (const patch of [
    { source: null },
    { text: 1 },
    { type: null },
    { line: -1 },
    { column: "1" },
  ])
    expect(() =>
      consoleMessage({
        message: { source: "javascript", level: "error", text: "marker", ...patch },
      }),
    ).toThrow();
  expect(
    consoleExpired(
      consoleMessage({
        message: { source: "other", level: "warning", text: "4 console messages are not shown." },
      }),
    ),
  ).toBe(true);
});
test("bounded first error survives loss, freeze, detach and later records", () => {
  const state = new ConsoleObservation();
  state.added({ context: "page", source: "console-api", text: "x".repeat(2000) });
  state.lose("actual loss");
  const frozen = state.freeze();
  state.added({ context: "page", source: "console-api", text: "later" });
  state.lose("later loss");
  expect(state.freeze()).toBe(frozen);
  expect(state.summary()).toBe(frozen);
  expect(frozen.first?.text.length).toBe(1024);
  expect(frozen.loss).toBe("actual loss");
});

test("worker classification uses original console type even for JavaScript sources", () => {
  expect(
    consoleFailure(
      consoleMessage({ message: { source: "javascript", level: "error", text: "uncaught" } }),
      false,
    ),
  ).toBe(false);
  expect(
    consoleFailure(
      consoleMessage({
        message: { source: "javascript", type: "log", level: "error", text: "uncaught" },
      }),
      false,
    ),
  ).toBe(true);
});
