// Derived from the shape and 37 mismatch rows of the retained sprite AssertionError.
// Synthetic geometry text keeps the regression independent of external native receipts.
export function largeAssertion() {
  const mismatches = Array.from(
    { length: 37 },
    (_, index) => `fixture ${index}: ${"U+2800 expected coverage, observed mismatch; ".repeat(90)}`,
  );
  const actual = `[\n${mismatches.map((row) => `  ${JSON.stringify(row)},`).join("\n")}\n]`;
  return {
    name: "AssertionError",
    message: "expected mismatches to deeply equal []",
    actual,
    expected: "[]",
    showDiff: true,
    operator: "deepStrictEqual",
    diff: `- Expected\n+ Received\n${actual}`,
    ok: false,
    stack: "AssertionError: expected mismatches to deeply equal []\n at original.test.ts:251:1",
    stacks: [{ file: "original.test.ts", line: 251, column: 1 }],
  };
}
