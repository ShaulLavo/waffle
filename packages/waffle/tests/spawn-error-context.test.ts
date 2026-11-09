import { expect, test } from "bun:test";
import { ExecutionUnwind } from "../core/unwind.js";
import { FilesystemError } from "../fs/protocol.js";
import { ProcessError } from "../proc/errors.js";
import { spawnError } from "../proc/start-failure.js";
import { formatHostError } from "./page-runner/protocol.js";

for (const [original, errno] of [
  [new RangeError("Out of memory"), 48],
  [new Error("host failure"), 29],
  [new FilesystemError(33, "resources"), 6],
  [new FilesystemError(51, "resources"), 6],
  [new ProcessError(41, "resources"), 6],
  [new FilesystemError(44, "missing"), 44],
] as const) {
  test(`spawn error retains ${original.name}, errno ${errno}, message and cause`, () => {
    const converted = spawnError(original);
    expect(converted.errno).toBe(errno);
    expect(converted.message).toBe(original.message);
    expect(String(converted)).toBe(`ProcessError: ${original.message}`);
    expect(converted.cause).toBe(original);
    expect(formatHostError(converted)).toContain(original.stack!);
  });
}

test("already mapped process errors keep identity and primitive failures keep their message", () => {
  const original = new ProcessError(48, "native");
  expect(spawnError(original)).toBe(original);
  const converted = spawnError("original string");
  expect(converted.message).toBe("original string");
  expect(converted.errno).toBe(29);
  expect(converted.cause).toBe("original string");
});

test("execution unwind still escapes unchanged", () => {
  const original = new ExecutionUnwind();
  expect(() => spawnError(original)).toThrow(ExecutionUnwind);
});
