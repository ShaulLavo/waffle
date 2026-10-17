import { expect, test } from "bun:test";
import { checkCoreBudget, CORE_BUDGET_BYTES } from "../tooling/runtime-size";

test("core gzip budget remains the hard 7 KiB gate", () => {
  expect(() => checkCoreBudget(CORE_BUDGET_BYTES)).not.toThrow();
  expect(() => checkCoreBudget(CORE_BUDGET_BYTES + 1)).toThrow("by 1 B");
});
