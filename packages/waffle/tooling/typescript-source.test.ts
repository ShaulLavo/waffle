import { expect, test } from "bun:test";
import { findHandwrittenJavaScript } from "./typescript-source.ts";

test("rejects handwritten JavaScript in source, provenance, and fixture directories", () => {
  const paths = [
    "packages/waffle/core/new.js",
    "packages/coreutils/scripts/new.mjs",
    "tools/new.cjs",
    "packages/coreutils/provenance/new.js",
    "packages/waffle/tests/fixtures/new.mjs",
  ];
  expect(findHandwrittenJavaScript(paths)).toEqual(paths);
});

test("allows only exact generated output and deliberate JavaScript test inputs", () => {
  const generated = "packages/waffle/dist/core/index.js";
  const fixture = "packages/waffle/tests/fixtures/deliberate-input.js";
  const unexpected = [
    "packages/waffle/dist/core/other.js",
    "packages/waffle/tests/fixtures/other-input.cjs",
  ];
  expect(
    findHandwrittenJavaScript([generated, fixture].concat(unexpected), {
      generatedOutput: [generated],
      testInputs: [fixture],
    }),
  ).toEqual(unexpected);
});

test("ignores TypeScript sources and declarations", () => {
  expect(
    findHandwrittenJavaScript([
      "packages/waffle/core/memory-views.ts",
      "packages/waffle/core/memory-views.d.ts",
      "docs/architecture.md",
    ]),
  ).toEqual([]);
});
