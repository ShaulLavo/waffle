import assert from "node:assert/strict";
import { test } from "bun:test";
import { selectCatalogs } from "./selection.ts";

test("echo selects only its English utility and both common catalogs", () => {
  assert.deepEqual(selectCatalogs("echo", "0.13.0"), [
    "uucore/en-US.ftl",
    "uucore-errors/en-US.ftl",
    "echo/en-US.ftl",
  ]);
});

test("registry utilities select their own catalog, not neighboring cached utilities", () => {
  assert.deepEqual(selectCatalogs("head", "0.12.0"), [
    "uucore/en-US.ftl",
    "uucore-errors/en-US.ftl",
    "head/en-US.ftl",
  ]);
  assert.deepEqual(selectCatalogs("ls", "0.12.0"), ["uucore/en-US.ftl", "uucore-errors/en-US.ftl"]);
});

test("selection rejects unknown programs and dependency versions", () => {
  assert.throws(() => selectCatalogs("multicall", "0.13.0"));
  assert.throws(() => selectCatalogs("echo", "0.14.0"));
});
