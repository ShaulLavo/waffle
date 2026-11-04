import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  sharedReservationFindings,
  unaccountedSharedConstruction,
} from "../tooling/shared-reservations.js";
test("shared constructor coverage rejects an unclassified allocation and classifies current source", () => {
  expect(
    unaccountedSharedConstruction(
      "browser/unfunded.ts",
      "new SharedArrayBuffer(0, { maxByteLength: 16777216 })",
    ),
  ).toBe(true);
  expect(sharedReservationFindings(join(import.meta.dir, ".."))).toEqual([]);
});
