import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkBaselineMonotonic,
  checkNestedTernaryBaseline,
  fingerprintExpression,
  loadBaseBaseline,
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
    expect(checkNestedTernaryBaseline(waffleRoot)).toEqual([]);
  });

  test("rejects adding a new nested ternary inside an exempt legacy file", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      const first = "a ? (b ? 1 : 2) : 3";
      writeFileSync(
        join(dir, "legacy.ts"),
        [
          `export const existing = (a: boolean, b: boolean) => (${first});`,
          "export const added = (a: boolean, b: boolean) => (a ? (b ? 4 : 5) : 6);",
        ].join("\n") + "\n",
      );
      const findings = checkNestedTernaryBaseline(
        dir,
        { "legacy.ts": [fingerprintExpression(first)] },
        oxlintBin,
      );
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("legacy.ts");
      expect(findings[0]).toContain("new nested ternary");
    });
  });

  test("rejects replacing a legacy nested ternary with a different nested ternary", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      const original = "a ? (b ? 1 : 2) : 3";
      const replacement = "a ? (b ? 9 : 8) : 7";
      writeFileSync(
        join(dir, "legacy.ts"),
        `export const swapped = (a: boolean, b: boolean) => (${replacement});\n`,
      );
      const findings = checkNestedTernaryBaseline(
        dir,
        { "legacy.ts": [fingerprintExpression(original)] },
        oxlintBin,
      );
      expect(findings.join("\n")).toContain("new nested ternary");
      expect(findings.join("\n")).toContain("can shrink");
    });
  });

  test("requires shrinking the baseline when a legacy violation is removed", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      writeFileSync(join(dir, "legacy.ts"), "export const clean = 1;\n");
      const findings = checkNestedTernaryBaseline(
        dir,
        { "legacy.ts": [fingerprintExpression("a ? (b ? 1 : 2) : 3")] },
        oxlintBin,
      );
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("can shrink");
      expect(findings[0]).toContain("remove from .oxlintrc.json overrides");
    });
  });

  test("rejects override list drift and non-monotonic baseline growth", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts", "sneaky.ts"]);
      const expr = "a ? (b ? 1 : 2) : 3";
      writeFileSync(
        join(dir, "legacy.ts"),
        `export const existing = (a: boolean, b: boolean) => (${expr});\n`,
      );
      writeFileSync(join(dir, "sneaky.ts"), "export const x = 1;\n");
      const findings = checkNestedTernaryBaseline(
        dir,
        { "legacy.ts": [fingerprintExpression(expr)] },
        oxlintBin,
      );
      expect(findings.join("\n")).toContain("sneaky.ts");
    });

    const fp1 = fingerprintExpression("a ? (b ? 1 : 2) : 3");
    const fp2 = fingerprintExpression("a ? (b ? 4 : 5) : 6");
    expect(checkBaselineMonotonic({ "a.ts": [fp1, fp2] }, { "a.ts": [fp1] })).toEqual([]);
    expect(checkBaselineMonotonic({ "a.ts": [fp1] }, {})).toEqual([]);
    expect(checkBaselineMonotonic({ "a.ts": [fp1] }, { "a.ts": [fp1, fp2] }).length).toBe(1);
    expect(checkBaselineMonotonic({ "a.ts": [fp1] }, { "b.ts": [fp1] }).length).toBe(1);
  });

  test("passes cleanly when the baseline has shrunk to empty", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, []);
      expect(checkNestedTernaryBaseline(dir, {}, oxlintBin)).toEqual([]);
    });
  });

  test("slices UTF-8 byte offsets accurately after non-ASCII text", () => {
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      const expr = "a ? (b ? 1 : 2) : 3";
      writeFileSync(
        join(dir, "legacy.ts"),
        `// 日本語コメント 🚀 — multi-byte UTF-8 prefix\nexport const v = (a: boolean, b: boolean) => (${expr});\n`,
      );
      expect(
        checkNestedTernaryBaseline(dir, { "legacy.ts": [fingerprintExpression(expr)] }, oxlintBin),
      ).toEqual([]);
    });
  });

  test("hashes exact UTF-8 expression bytes (literals, regexes, TS type args, private fields)", () => {
    expect(fingerprintExpression('a ? (b ? "x  y" : "z") : "w"')).not.toBe(
      fingerprintExpression('a ? (b ? "x y" : "z") : "w"'),
    );
    expect(fingerprintExpression("a ? (b ? `x  y` : `z`) : `w`")).not.toBe(
      fingerprintExpression("a ? (b ? `x y` : `z`) : `w`"),
    );
    expect(fingerprintExpression('a ? (b ? /* " */ "x  y" : "z") : "w"')).not.toBe(
      fingerprintExpression('a ? (b ? /* " */ "x y" : "z") : "w"'),
    );
    expect(fingerprintExpression("a ? (b ? /x  y/ : /z/) : /w/")).not.toBe(
      fingerprintExpression("a ? (b ? /x y/ : /z/) : /w/"),
    );
    expect(fingerprintExpression("a ? (b ? f<number>() : 2) : 3")).not.toBe(
      fingerprintExpression("a ? (b ? f<string>() : 2) : 3"),
    );
    withTempRoot((dir) => {
      writeOxlintRc(dir, ["legacy.ts"]);
      const expr = "a ? (b ? this.#x : 2) : 3";
      writeFileSync(
        join(dir, "legacy.ts"),
        `export class Box { #x = 1; read(a: boolean, b: boolean) { return ${expr}; } }\n`,
      );
      expect(
        checkNestedTernaryBaseline(dir, { "legacy.ts": [fingerprintExpression(expr)] }, oxlintBin),
      ).toEqual([]);
    });
  });

  test("fails closed when the requested git base ref cannot be resolved", () => {
    const result = loadBaseBaseline(waffleRoot, "nonexistent-branch-for-monotonic-check");
    expect(result.error).toContain("unavailable");
  });
});
