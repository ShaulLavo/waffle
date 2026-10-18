import { expect, test } from "bun:test";
import { DIAGNOSTIC_STALL_TIMEOUT_MS, drainDiagnostic } from "../browser/diagnostic.js";
import { ProcessError } from "../proc/types.js";

test("diagnostic partial writes keep the synchronous fast path and byte ordering", () => {
  const chunks: Uint8Array[] = [];
  const bytes = new TextEncoder().encode("long diagnostic λ");
  expect(drainDiagnostic(bytes, part => { const chunk = part.slice(0, 3); chunks.push(chunk); return chunk.length; })).toBeUndefined();
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(bytes);
});

for (const result of [0, -64, -8, NaN, 999]) test(`diagnostic invalid/closed write ${result} fails without changing an outcome`, () => {
  expect(() => drainDiagnostic(new Uint8Array(2), () => result)).toThrow(ProcessError);
});

test("diagnostic writer exceptions become typed failures with the unwritten span", () => {
  expect(() => drainDiagnostic(new Uint8Array(7), () => { throw new Error("closed"); })).toThrow(
    expect.objectContaining({ errno: 29, message: expect.stringContaining("7 of 7 diagnostic bytes unwritten") }),
  );
});

test("diagnostic cancellation retains a typed error and unwritten count", async () => {
  let active = true;
  const pending = drainDiagnostic(new Uint8Array(13), () => -6, () => active);
  active = false;
  await expect(pending).rejects.toMatchObject({ errno: 11, message: expect.stringContaining("13 of 13 diagnostic bytes unwritten") });
});

test("steady diagnostic progress resets the no-progress deadline beyond five total seconds", async () => {
  const started = performance.now(), chunks: number[] = [];
  const pending = drainDiagnostic(new Uint8Array([11, 22, 33]), bytes => {
    const due = chunks.length * (DIAGNOSTIC_STALL_TIMEOUT_MS / 2 + 100);
    if (performance.now() - started < due) return -6;
    chunks.push(bytes[0]!); return 1;
  });
  await pending;
  expect(performance.now() - started).toBeGreaterThan(DIAGNOSTIC_STALL_TIMEOUT_MS);
  expect(chunks).toEqual([11, 22, 33]);
}, 10_000);
