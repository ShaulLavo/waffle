import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("compiled fairness modes belong to the existing triangle producer", () => {
  const source = readFileSync(new URL("./fixtures/gpu/triangle.c", import.meta.url), "utf8");
  expect(source).toContain('"--fairness-heavy"');
  expect(source).toContain('"--fairness-peer"');
  expect(source).toContain('"--fairness-seed"');
});
