import assert from "node:assert/strict";
import { awkCases } from "../tests/awk-cases.ts";
import { executeNative, readOracle, verifyNativeIdentity } from "../tests/record-awk-oracle.ts";

verifyNativeIdentity();
const oracle = readOracle();
for (const fixture of awkCases)
  assert.deepEqual(executeNative(fixture), oracle[fixture.name], fixture.name);
assert.throws(
  () =>
    executeNative(
      { name: "real native awk infinite loop deadline", args: ["BEGIN { for (;;) {} }"] },
      150,
    ),
  /timed out|ETIMEDOUT/,
);
console.log(`Pinned native onetrue-awk: ${awkCases.length} exact observations passed`);
