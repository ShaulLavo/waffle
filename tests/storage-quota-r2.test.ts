import { expect, test } from "bun:test";
import { quotaMatrix } from "../tooling/storage-quota-r2.js";
import { churnSaves } from "./storage-quota-r2-browser.js";

test("bounded quota proof keeps both adapters, failures, recovery, checkpoint debt and cleanup cells", () => {
  const matrix = quotaMatrix();
  expect(matrix).toHaveLength(11);
  expect(new Set(matrix.map(({ backend, cell }) => `${backend}/${cell}`)).size).toBe(11);
  for (const backend of ["indexeddb", "opfs"]) {
    expect(matrix.filter((entry) => entry.backend === backend).map((entry) => entry.cell)).toEqual(
      backend === "opfs"
        ? ["churn", "payload-quota", "commit", "recovery-root", "checkpoint-debt", "cleanup-retry"]
        : ["churn", "payload-quota", "commit", "recovery-root", "checkpoint-debt"],
    );
  }
  expect(churnSaves).toBe(96);
});
