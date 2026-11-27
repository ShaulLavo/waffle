import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkNestedTernaryBaseline,
  LEGACY_NESTED_TERNARY_COUNTS,
} from "../tooling/nested-ternary-baseline.js";

const waffleRoot = resolve(import.meta.dir, "..");
const oxlintBin = join(waffleRoot, "node_modules/.bin/oxlint");

function withTempRoot(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "waffle-nt-baseline-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeOxlintRc(dir: string, exemptFiles: readonly string[]): void {
  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({
      rules: { "no-nested-ternary": "error", "no-else-return": "error", "max-depth": ["error", 3] },
      overrides: [{ files: exemptFiles, rules: { "no-nested-ternary": "off" } }],
    }),
  );
}

describe("nested-ternary shrinking baseline", () => {
  test("current repository matches the exact per-file legacy baseline", () => {
    expect(Object.keys(LEGACY_NESTED_TERNARY_COUNTS).length).toBeGreaterThan(0);
    expect(checkNestedTernaryBaseline(waffleRoot)).toEqual([]);
  });

  test("rejects adding a new nested ternary inside an exempt legacy file", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      writeFileSync(
        join(dir, "legacy.ts"),
        [
          "export const existing = (a: boolean, b: boolean) => (a ? (b ? 1 : 2) : 3);",
          "export const added = (a: boolean, b: boolean) => (a ? (b ? 4 : 5) : 6);",
        ].join("\n") + "\n",
      );
      const findings = checkNestedTernaryBaseline(dir, { "legacy.ts": 1 }, oxlintBin);
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("legacy.ts");
      expect(findings[0]).toContain("expected 1, found 2");
    });
  });

  test("requires shrinking the baseline when a legacy violation is removed", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      writeFileSync(join(dir, "legacy.ts"), "export const clean = 1;\n");
      const findings = checkNestedTernaryBaseline(dir, { "legacy.ts": 1 }, oxlintBin);
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("can shrink");
      expect(findings[0]).toContain("remove from .oxlintrc.json overrides");
    });
  });

  test("rejects override list drift between .oxlintrc.json and baseline counts", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts", "sneaky.ts"]);
      writeFileSync(
        join(dir, "legacy.ts"),
        "export const existing = (a: boolean, b: boolean) => (a ? (b ? 1 : 2) : 3);\n",
      );
      writeFileSync(join(dir, "sneaky.ts"), "export const x = 1;\n");
      const findings = checkNestedTernaryBaseline(dir, { "legacy.ts": 1 }, oxlintBin);
      expect(findings.join("\n")).toContain("sneaky.ts");
    });
  });
});
