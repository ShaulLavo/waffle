import { expect, test } from "bun:test";
import { assertSingleAppend } from "./recovery-r42-browser-runner";

const receipt = { id: { session: 2, sequence: 3 }, cut: { history: "unit", generation: 2 } };
const publication = { receipt, changes: [{ kind: "bytes", offset: 3, size: 4 }] };
const changes = { kind: "changes", publications: [publication] };

test("native replay invariant refuses a fresh append instead of exact identity replay", () => {
  expect(() => assertSingleAppend([10, 20, 30, 90], changes, receipt)).not.toThrow();
  expect(() => assertSingleAppend([10, 20, 30, 90, 90], changes, receipt)).toThrow("lost reply must not append twice");
  expect(() => assertSingleAppend([10, 20, 30, 90], { ...changes, publications: [publication, publication] }, receipt)).toThrow("exact replay must not add publication groups");
  expect(() => assertSingleAppend([10, 20, 30, 90], changes, { ...receipt, id: { session: 3, sequence: 3 } })).toThrow();
});
