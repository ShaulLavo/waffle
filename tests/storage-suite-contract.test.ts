import { expect, test } from "bun:test";
import { storageTests, opfsStorageTests } from "./storage-browser.js";

const runtimeLabels = (tests: ReturnType<typeof storageTests>) => tests.filter(test => test.label.includes("actual filesystem worker boundary"));

test("exported backend suites do not require a filesystem worker route", () => {
  expect(runtimeLabels(storageTests())).toEqual([]);
  expect(runtimeLabels(opfsStorageTests())).toEqual([]);
});

test("runtime startup probes require a consumer-supplied filesystem worker URL", () => {
  expect(runtimeLabels(storageTests("/fs-worker.js"))).toHaveLength(2);
  expect(runtimeLabels(opfsStorageTests("/fs-worker.js"))).toHaveLength(1);
});
